// uspwip-wl-overlay
//
// Tiny native helper that shows the USPWIP overlay on native Wayland.
//
// Chromium/Electron cannot create wlr-layer-shell surfaces, and xdg-shell has
// no "always on top" or reliable "click through", so on Wayland the overlay is
// rendered offscreen by Electron and the pixels are streamed to this helper.
// The helper owns a single zwlr_layer_surface_v1 on the OVERLAY layer that:
//   * sits above every normal and fullscreen window (layer = overlay),
//   * ignores all input (empty input region, no keyboard interactivity),
//   * ignores other surfaces' exclusive zones (exclusive_zone = -1),
//   * renders at the output's native (fractional) scale via wp_fractional_scale_v1
//     + wp_viewporter, and
//   * paces commits with that output's frame callbacks, so mixed-refresh setups
//     each run at their own rate.
//
// Only libwayland-client is needed at runtime.
//
// IPC with the parent (Electron main process):
//   stdout: newline-delimited JSON events (see emit_* below)
//   stdin:  binary commands. Every command starts with a header of HDR_WORDS
//           little-endian uint32: [magic, cmd, payload_len, a0..a6]
//     CMD_SHOW  payload = output name (UTF-8, may be empty = compositor's choice)
//     CMD_HIDE  no payload
//     CMD_FRAME a0=full_w a1=full_h a2=x a3=y a4=w a5=h a6=generation,
//               payload = w*h*4 bytes of premultiplied BGRA (wl_shm ARGB8888)
//     CMD_QUIT  no payload
//   The helper replies {"type":"ready"} after consuming each CMD_FRAME so the
//   parent never has more than one frame in flight (credit based flow control).
//
// The helper exits when stdin reaches EOF, so it can never outlive the app.
//
// `uspwip-wl-overlay --probe` prints the compositor's capabilities as JSON and
// exits 0 only if a layer-shell overlay is possible.

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <time.h>
#include <unistd.h>

#include <wayland-client.h>

#include "fractional-scale-v1-client-protocol.h"
#include "viewporter-client-protocol.h"
#include "wlr-layer-shell-unstable-v1-client-protocol.h"
#include "xdg-output-unstable-v1-client-protocol.h"

#define MAGIC 0x57505355u // "USPW" read as little-endian uint32
enum { CMD_SHOW = 1, CMD_HIDE = 2, CMD_FRAME = 3, CMD_QUIT = 4 };
#define HDR_WORDS 10
#define HDR_BYTES (HDR_WORDS * 4)
#define MAX_DIM 16384
#define MAX_PAYLOAD (256u * 1024u * 1024u)
#define MAX_NAME 255
#define NBUF 3
#define LAYER_NAMESPACE "uspwip-overlay"

#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))

struct rect {
  int32_t x, y, w, h; // w <= 0 || h <= 0 means empty
};

static bool rect_empty(struct rect r) { return r.w <= 0 || r.h <= 0; }

static void rect_union(struct rect *a, struct rect b) {
  if (rect_empty(b)) return;
  if (rect_empty(*a)) {
    *a = b;
    return;
  }
  int32_t x1 = MIN(a->x, b.x), y1 = MIN(a->y, b.y);
  int32_t x2 = MAX(a->x + a->w, b.x + b.w), y2 = MAX(a->y + a->h, b.y + b.h);
  *a = (struct rect){x1, y1, x2 - x1, y2 - y1};
}

struct output {
  struct wl_list link;
  uint32_t global_name;
  struct wl_output *wl;
  struct zxdg_output_v1 *xdg;
  char name[64];
  char desc[160];
  int32_t x, y, lw, lh; // logical geometry (xdg-output)
  int32_t mw, mh;       // current mode, physical pixels
  int32_t refresh;      // mHz
  int32_t scale;        // integer wl_output scale
  int32_t transform;
  bool have_logical;
  bool have_name; // real name received (wl_output v4 or xdg_output v2)
};

struct buffer {
  struct wl_buffer *wl;
  uint8_t *data;
  size_t size;
  int32_t w, h;
  bool busy;
  struct rect stale; // region not yet copied from the canvas
};

static struct {
  struct wl_display *display;
  struct wl_registry *registry;
  struct wl_compositor *compositor;
  struct wl_shm *shm;
  struct zwlr_layer_shell_v1 *layer_shell;
  struct zxdg_output_manager_v1 *xdg_output_manager;
  struct wp_viewporter *viewporter;
  struct wp_fractional_scale_manager_v1 *fractional_manager;
  struct wl_list outputs;
  char *last_outputs_json;

  // the overlay surface (exists between CMD_SHOW and CMD_HIDE/closed)
  struct wl_surface *surface;
  struct zwlr_layer_surface_v1 *layer_surface;
  struct wp_viewport *viewport;
  struct wp_fractional_scale_v1 *fractional;
  struct wl_callback *frame_cb;
  struct output *target;  // requested output (NULL = compositor's choice)
  struct output *entered; // output the surface is actually on
  bool configured;
  int32_t lw, lh;        // logical size from configure
  uint32_t scale120;     // wp_fractional_scale_v1 preferred scale, 0 = unknown
  int32_t buffer_scale;  // wl_surface.preferred_buffer_scale, 0 = unknown
  uint32_t generation;   // bumped every time the required buffer size changes
  int32_t ann_bw, ann_bh, ann_refresh;
  uint32_t ann_scale120;
  bool ann_valid;

  // CPU copy of the latest frame; buffers are refreshed from it lazily
  uint8_t *canvas;
  int32_t cw, ch;
  struct rect damage; // surface damage not yet committed
  struct buffer bufs[NBUF];

  // stdin parsing
  uint8_t *in;
  size_t in_len, in_cap;

  bool running;
  bool probe; // --probe: no event stream on stdout
  bool debug;
  unsigned long stat_frames, stat_commits, stat_bytes;
  struct timespec stat_t0;
} st;

// ---------------------------------------------------------------- output IO

static void write_all(int fd, const char *buf, size_t len) {
  while (len > 0) {
    ssize_t n = write(fd, buf, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) {
        struct pollfd p = {.fd = fd, .events = POLLOUT};
        poll(&p, 1, 1000);
        continue;
      }
      // parent went away
      exit(0);
    }
    buf += n;
    len -= (size_t)n;
  }
}

struct sbuf {
  char *s;
  size_t len, cap;
};

static void sb_putn(struct sbuf *b, const char *s, size_t n) {
  if (b->len + n + 1 > b->cap) {
    size_t cap = MAX(b->cap * 2, b->len + n + 256);
    char *p = realloc(b->s, cap);
    if (!p) abort();
    b->s = p;
    b->cap = cap;
  }
  memcpy(b->s + b->len, s, n);
  b->len += n;
  b->s[b->len] = '\0';
}

static void sb_printf(struct sbuf *b, const char *fmt, ...) {
  char tmp[512];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
  va_end(ap);
  if (n > 0) sb_putn(b, tmp, MIN((size_t)n, sizeof tmp - 1));
}

static void sb_json_str(struct sbuf *b, const char *s) {
  sb_putn(b, "\"", 1);
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\\') {
      char e[2] = {'\\', (char)*p};
      sb_putn(b, e, 2);
    } else if (*p < 0x20 || *p == 0x7f) {
      sb_printf(b, "\\u%04x", *p);
    } else {
      sb_putn(b, (const char *)p, 1);
    }
  }
  sb_putn(b, "\"", 1);
}

static void emit_sb(struct sbuf *b) {
  if (st.probe) {
    free(b->s);
    return;
  }
  sb_putn(b, "\n", 1);
  write_all(STDOUT_FILENO, b->s, b->len);
  free(b->s);
}

static void emit_simple(const char *type) {
  struct sbuf b = {0};
  sb_printf(&b, "{\"type\":\"%s\"}", type);
  emit_sb(&b);
}

static void emit_error(const char *msg) {
  struct sbuf b = {0};
  sb_printf(&b, "{\"type\":\"error\",\"message\":");
  sb_json_str(&b, msg);
  sb_putn(&b, "}", 1);
  emit_sb(&b);
}

static void dbg(const char *fmt, ...) {
  if (!st.debug) return;
  va_list ap;
  va_start(ap, fmt);
  fprintf(stderr, "[uspwip-wl-overlay] ");
  vfprintf(stderr, fmt, ap);
  fprintf(stderr, "\n");
  va_end(ap);
}

// ------------------------------------------------------------------ outputs

static double output_scale_guess(const struct output *o) {
  // logical size vs. physical mode size gives the exact fractional scale the
  // compositor uses, before the surface even exists
  if (o->have_logical && o->lw > 0 && o->lh > 0 && o->mw > 0 && o->mh > 0) {
    double s = (double)MAX(o->mw, o->mh) / (double)MAX(o->lw, o->lh);
    if (s > 0.2 && s < 10) return s;
  }
  return o->scale > 0 ? o->scale : 1;
}

static void emit_outputs(void) {
  struct sbuf b = {0};
  sb_printf(&b, "{\"type\":\"outputs\",\"outputs\":[");
  struct output *o;
  bool first = true;
  wl_list_for_each_reverse(o, &st.outputs, link) {
    if (!o->name[0]) continue; // not announced yet
    if (!first) sb_putn(&b, ",", 1);
    first = false;
    sb_printf(&b, "{\"name\":");
    sb_json_str(&b, o->name);
    sb_printf(&b, ",\"description\":");
    sb_json_str(&b, o->desc);
    sb_printf(&b, ",\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d,\"scale\":%.4f,\"refresh\":%d}",
              o->x, o->y, o->have_logical ? o->lw : o->mw, o->have_logical ? o->lh : o->mh,
              output_scale_guess(o), o->refresh);
  }
  sb_printf(&b, "]}");
  if (st.last_outputs_json && strcmp(st.last_outputs_json, b.s) == 0) {
    free(b.s);
    return;
  }
  free(st.last_outputs_json);
  st.last_outputs_json = strdup(b.s);
  emit_sb(&b);
}

static struct output *find_output_by_wl(struct wl_output *wl) {
  struct output *o;
  wl_list_for_each(o, &st.outputs, link) if (o->wl == wl) return o;
  return NULL;
}

static struct output *find_output_by_name(const char *name) {
  struct output *o;
  wl_list_for_each(o, &st.outputs, link) if (strcmp(o->name, name) == 0) return o;
  return NULL;
}

static void announce(void);

static void output_geometry(void *data, struct wl_output *wl, int32_t x, int32_t y, int32_t pw,
                            int32_t ph, int32_t subpixel, const char *make, const char *model,
                            int32_t transform) {
  (void)wl, (void)pw, (void)ph, (void)subpixel, (void)make, (void)model;
  struct output *o = data;
  o->transform = transform;
  if (!o->have_logical) {
    o->x = x;
    o->y = y;
  }
}

static void output_mode(void *data, struct wl_output *wl, uint32_t flags, int32_t w, int32_t h,
                        int32_t refresh) {
  (void)wl;
  struct output *o = data;
  if (!(flags & WL_OUTPUT_MODE_CURRENT)) return;
  o->mw = w;
  o->mh = h;
  o->refresh = refresh;
}

static void output_done(void *data, struct wl_output *wl) {
  (void)data, (void)wl;
  emit_outputs();
  announce();
}

static void output_scale(void *data, struct wl_output *wl, int32_t factor) {
  (void)wl;
  ((struct output *)data)->scale = factor;
}

static void output_name(void *data, struct wl_output *wl, const char *name) {
  (void)wl;
  struct output *o = data;
  snprintf(o->name, sizeof o->name, "%s", name);
  o->have_name = true;
}

static void output_description(void *data, struct wl_output *wl, const char *desc) {
  (void)wl;
  struct output *o = data;
  snprintf(o->desc, sizeof o->desc, "%s", desc);
}

static const struct wl_output_listener output_listener = {
    .geometry = output_geometry,
    .mode = output_mode,
    .done = output_done,
    .scale = output_scale,
#ifdef WL_OUTPUT_NAME_SINCE_VERSION
    .name = output_name,
    .description = output_description,
#endif
};

static void xdg_output_logical_position(void *data, struct zxdg_output_v1 *x, int32_t px,
                                        int32_t py) {
  (void)x;
  struct output *o = data;
  o->x = px;
  o->y = py;
  o->have_logical = true;
}

static void xdg_output_logical_size(void *data, struct zxdg_output_v1 *x, int32_t w, int32_t h) {
  (void)x;
  struct output *o = data;
  o->lw = w;
  o->lh = h;
  o->have_logical = true;
}

static void xdg_output_done(void *data, struct zxdg_output_v1 *x) {
  // deprecated since v3 (wl_output.done is authoritative), harmless to handle
  (void)data, (void)x;
}

static void xdg_output_name(void *data, struct zxdg_output_v1 *x, const char *name) {
  (void)x;
  struct output *o = data;
  if (o->have_name) return; // wl_output's own name wins
  snprintf(o->name, sizeof o->name, "%s", name);
  o->have_name = true;
}

static void xdg_output_description(void *data, struct zxdg_output_v1 *x, const char *desc) {
  (void)x;
  struct output *o = data;
  if (!o->desc[0]) snprintf(o->desc, sizeof o->desc, "%s", desc);
}

static const struct zxdg_output_v1_listener xdg_output_listener = {
    .logical_position = xdg_output_logical_position,
    .logical_size = xdg_output_logical_size,
    .done = xdg_output_done,
    .name = xdg_output_name,
    .description = xdg_output_description,
};

static void output_attach_xdg(struct output *o) {
  if (!st.xdg_output_manager || o->xdg) return;
  o->xdg = zxdg_output_manager_v1_get_xdg_output(st.xdg_output_manager, o->wl);
  zxdg_output_v1_add_listener(o->xdg, &xdg_output_listener, o);
}

static void output_destroy(struct output *o) {
  if (st.target == o) st.target = NULL;
  if (st.entered == o) st.entered = NULL;
  if (o->xdg) zxdg_output_v1_destroy(o->xdg);
  if (wl_output_get_version(o->wl) >= WL_OUTPUT_RELEASE_SINCE_VERSION)
    wl_output_release(o->wl);
  else
    wl_output_destroy(o->wl);
  wl_list_remove(&o->link);
  free(o);
}

// ------------------------------------------------------------------ buffers

static void buffer_release(void *data, struct wl_buffer *wl) {
  (void)wl;
  ((struct buffer *)data)->busy = false;
}

static const struct wl_buffer_listener buffer_listener = {.release = buffer_release};

static void buffer_destroy(struct buffer *b) {
  if (b->wl) wl_buffer_destroy(b->wl);
  if (b->data) munmap(b->data, b->size);
  memset(b, 0, sizeof *b);
}

static bool buffer_create(struct buffer *b, int32_t w, int32_t h) {
  size_t stride = (size_t)w * 4, size = stride * (size_t)h;
  int fd = memfd_create("uspwip-wl-overlay", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (fd < 0) return false;
  if (ftruncate(fd, (off_t)size) < 0) {
    close(fd);
    return false;
  }
  void *data = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (data == MAP_FAILED) {
    close(fd);
    return false;
  }
  // the compositor must never be able to shrink the pool under us
  fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK | F_SEAL_SEAL);
  struct wl_shm_pool *pool = wl_shm_create_pool(st.shm, fd, (int32_t)size);
  b->wl = wl_shm_pool_create_buffer(pool, 0, w, h, (int32_t)stride, WL_SHM_FORMAT_ARGB8888);
  wl_shm_pool_destroy(pool);
  close(fd);
  wl_buffer_add_listener(b->wl, &buffer_listener, b);
  b->data = data;
  b->size = size;
  b->w = w;
  b->h = h;
  b->busy = false;
  b->stale = (struct rect){0, 0, w, h};
  return true;
}

static void buffers_destroy_all(void) {
  for (int i = 0; i < NBUF; i++) buffer_destroy(&st.bufs[i]);
}

static struct buffer *buffer_get_free(void) {
  for (int i = 0; i < NBUF; i++) {
    struct buffer *b = &st.bufs[i];
    if (b->wl && !b->busy && (b->w != st.cw || b->h != st.ch)) buffer_destroy(b);
    if (b->wl && !b->busy) return b;
  }
  for (int i = 0; i < NBUF; i++) {
    struct buffer *b = &st.bufs[i];
    if (!b->wl) return buffer_create(b, st.cw, st.ch) ? b : NULL;
  }
  return NULL; // all busy, wait for a release
}

static void buffer_sync_from_canvas(struct buffer *b) {
  struct rect r = b->stale;
  if (rect_empty(r)) return;
  size_t stride = (size_t)st.cw * 4;
  for (int32_t row = r.y; row < r.y + r.h; row++) {
    size_t off = (size_t)row * stride + (size_t)r.x * 4;
    memcpy(b->data + off, st.canvas + off, (size_t)r.w * 4);
  }
  b->stale = (struct rect){0};
}

// ------------------------------------------------------------------ surface

static double surface_scale(void) {
  if (st.scale120) return st.scale120 / 120.0;
  if (st.buffer_scale > 0) return st.buffer_scale;
  struct output *o = st.entered ? st.entered : st.target;
  return o ? output_scale_guess(o) : 1.0;
}

static void announce(void) {
  if (!st.surface || !st.configured || st.lw <= 0 || st.lh <= 0) return;
  double s = surface_scale();
  if (!st.viewporter) s = ceil(s); // without a viewport only integer buffer scales work
  int32_t bw = (int32_t)lround(st.lw * s), bh = (int32_t)lround(st.lh * s);
  bw = MIN(MAX(bw, 1), MAX_DIM);
  bh = MIN(MAX(bh, 1), MAX_DIM);
  uint32_t s120 = (uint32_t)lround(s * 120);
  struct output *o = st.entered ? st.entered : st.target;
  int32_t refresh = o ? o->refresh : 0;
  if (st.ann_valid && st.ann_bw == bw && st.ann_bh == bh && st.ann_scale120 == s120 &&
      st.ann_refresh == refresh)
    return;
  bool size_changed = !st.ann_valid || st.ann_bw != bw || st.ann_bh != bh || st.ann_scale120 != s120;
  if (size_changed) st.generation++;
  st.ann_valid = true;
  st.ann_bw = bw;
  st.ann_bh = bh;
  st.ann_scale120 = s120;
  st.ann_refresh = refresh;

  struct sbuf b = {0};
  sb_printf(&b, "{\"type\":\"configured\",\"generation\":%u,\"output\":", st.generation);
  sb_json_str(&b, o ? o->name : "");
  sb_printf(&b, ",\"width\":%d,\"height\":%d,\"scale\":%.6f,\"bufferWidth\":%d,\"bufferHeight\":%d,"
                "\"refresh\":%d}",
            st.lw, st.lh, s120 / 120.0, bw, bh, refresh);
  emit_sb(&b);
}

static void surface_destroy(void) {
  if (st.frame_cb) wl_callback_destroy(st.frame_cb);
  if (st.fractional) wp_fractional_scale_v1_destroy(st.fractional);
  if (st.viewport) wp_viewport_destroy(st.viewport);
  if (st.layer_surface) zwlr_layer_surface_v1_destroy(st.layer_surface);
  if (st.surface) wl_surface_destroy(st.surface);
  st.frame_cb = NULL;
  st.fractional = NULL;
  st.viewport = NULL;
  st.layer_surface = NULL;
  st.surface = NULL;
  st.configured = false;
  st.entered = NULL;
  st.target = NULL;
  st.scale120 = 0;
  st.buffer_scale = 0;
  st.ann_valid = false;
  st.damage = (struct rect){0};
  // buffers may still be held by the compositor for the old surface
  buffers_destroy_all();
  free(st.canvas);
  st.canvas = NULL;
  st.cw = st.ch = 0;
}

static void try_commit(void);

static void frame_done(void *data, struct wl_callback *cb, uint32_t time) {
  (void)data, (void)time;
  wl_callback_destroy(cb);
  st.frame_cb = NULL;
  try_commit();
}

static const struct wl_callback_listener frame_listener = {.done = frame_done};

static void try_commit(void) {
  if (!st.surface || !st.configured || st.frame_cb || !st.canvas) return;
  if (rect_empty(st.damage)) return;
  struct buffer *b = buffer_get_free();
  if (!b) return; // retried from the next buffer release / frame
  buffer_sync_from_canvas(b);

  wl_surface_attach(st.surface, b->wl, 0, 0);
  if (wl_surface_get_version(st.surface) >= WL_SURFACE_DAMAGE_BUFFER_SINCE_VERSION)
    wl_surface_damage_buffer(st.surface, st.damage.x, st.damage.y, st.damage.w, st.damage.h);
  else
    wl_surface_damage(st.surface, 0, 0, INT32_MAX, INT32_MAX);
  if (st.viewport) {
    wp_viewport_set_destination(st.viewport, st.lw, st.lh);
  } else {
    int32_t k = (int32_t)lround(surface_scale());
    if (k < 1 || st.cw % k || st.ch % k) k = 1;
    wl_surface_set_buffer_scale(st.surface, k);
  }
  st.frame_cb = wl_surface_frame(st.surface);
  wl_callback_add_listener(st.frame_cb, &frame_listener, NULL);
  wl_surface_commit(st.surface);
  b->busy = true;
  st.damage = (struct rect){0};
  st.stat_commits++;
}

static void layer_configure(void *data, struct zwlr_layer_surface_v1 *ls, uint32_t serial,
                            uint32_t w, uint32_t h) {
  (void)data;
  zwlr_layer_surface_v1_ack_configure(ls, serial);
  st.lw = (int32_t)MIN(w, MAX_DIM);
  st.lh = (int32_t)MIN(h, MAX_DIM);
  st.configured = true;
  dbg("configure %ux%u", w, h);
  announce();
  try_commit();
}

static void layer_closed(void *data, struct zwlr_layer_surface_v1 *ls) {
  (void)data, (void)ls;
  struct sbuf b = {0};
  struct output *o = st.entered ? st.entered : st.target;
  sb_printf(&b, "{\"type\":\"closed\",\"output\":");
  sb_json_str(&b, o ? o->name : "");
  sb_putn(&b, "}", 1);
  surface_destroy();
  emit_sb(&b);
}

static const struct zwlr_layer_surface_v1_listener layer_listener = {
    .configure = layer_configure,
    .closed = layer_closed,
};

static void fractional_preferred_scale(void *data, struct wp_fractional_scale_v1 *f,
                                       uint32_t scale) {
  (void)data, (void)f;
  dbg("preferred fractional scale %u/120", scale);
  st.scale120 = scale;
  announce();
}

static const struct wp_fractional_scale_v1_listener fractional_listener = {
    .preferred_scale = fractional_preferred_scale,
};

static void surface_enter(void *data, struct wl_surface *s, struct wl_output *wl) {
  (void)data, (void)s;
  struct output *o = find_output_by_wl(wl);
  if (o) {
    dbg("entered %s", o->name);
    st.entered = o;
    announce();
  }
}

static void surface_leave(void *data, struct wl_surface *s, struct wl_output *wl) {
  (void)data, (void)s;
  if (st.entered && st.entered->wl == wl) st.entered = NULL;
}

#ifdef WL_SURFACE_PREFERRED_BUFFER_SCALE_SINCE_VERSION
static void surface_preferred_buffer_scale(void *data, struct wl_surface *s, int32_t factor) {
  (void)data, (void)s;
  st.buffer_scale = factor;
  announce();
}

static void surface_preferred_buffer_transform(void *data, struct wl_surface *s, uint32_t t) {
  (void)data, (void)s, (void)t;
}
#endif

static const struct wl_surface_listener surface_listener = {
    .enter = surface_enter,
    .leave = surface_leave,
#ifdef WL_SURFACE_PREFERRED_BUFFER_SCALE_SINCE_VERSION
    .preferred_buffer_scale = surface_preferred_buffer_scale,
    .preferred_buffer_transform = surface_preferred_buffer_transform,
#endif
};

static void surface_create(const char *output_name) {
  surface_destroy();
  struct output *o = NULL;
  if (output_name[0]) {
    o = find_output_by_name(output_name);
    if (!o) emit_error("unknown output, letting the compositor choose");
  }
  st.target = o;
  st.surface = wl_compositor_create_surface(st.compositor);
  wl_surface_add_listener(st.surface, &surface_listener, NULL);
  if (st.fractional_manager) {
    st.fractional = wp_fractional_scale_manager_v1_get_fractional_scale(st.fractional_manager,
                                                                         st.surface);
    wp_fractional_scale_v1_add_listener(st.fractional, &fractional_listener, NULL);
  }
  if (st.viewporter) st.viewport = wp_viewporter_get_viewport(st.viewporter, st.surface);

  st.layer_surface = zwlr_layer_shell_v1_get_layer_surface(
      st.layer_shell, st.surface, o ? o->wl : NULL, ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY,
      LAYER_NAMESPACE);
  zwlr_layer_surface_v1_add_listener(st.layer_surface, &layer_listener, NULL);
  zwlr_layer_surface_v1_set_size(st.layer_surface, 0, 0);
  zwlr_layer_surface_v1_set_anchor(
      st.layer_surface,
      ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM |
          ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT);
  zwlr_layer_surface_v1_set_exclusive_zone(st.layer_surface, -1);
  zwlr_layer_surface_v1_set_keyboard_interactivity(st.layer_surface, 0);

  // empty input region => every click/scroll/hover goes to whatever is below
  struct wl_region *region = wl_compositor_create_region(st.compositor);
  wl_surface_set_input_region(st.surface, region);
  wl_region_destroy(region);

  wl_surface_commit(st.surface);
}

// ------------------------------------------------------------------ frames

static void handle_frame(const uint32_t *h, const uint8_t *px, uint32_t len) {
  uint32_t fw = h[3], fh = h[4], x = h[5], y = h[6], w = h[7], hh = h[8], gen = h[9];
  if (fw == 0 || fh == 0 || fw > MAX_DIM || fh > MAX_DIM || w > fw || hh > fh || x > fw - w ||
      y > fh - hh || (uint64_t)w * hh * 4 != len) {
    emit_error("malformed frame");
    return;
  }
  if (!st.surface || gen != st.generation) return; // stale size, drop
  if ((int32_t)fw != st.cw || (int32_t)fh != st.ch || !st.canvas) {
    free(st.canvas);
    st.canvas = calloc((size_t)fw * fh, 4);
    if (!st.canvas) {
      emit_error("out of memory");
      st.cw = st.ch = 0;
      return;
    }
    st.cw = (int32_t)fw;
    st.ch = (int32_t)fh;
    for (int i = 0; i < NBUF; i++) st.bufs[i].stale = (struct rect){0, 0, st.cw, st.ch};
    st.damage = (struct rect){0, 0, st.cw, st.ch};
  }
  size_t stride = (size_t)fw * 4;
  for (uint32_t row = 0; row < hh; row++)
    memcpy(st.canvas + (size_t)(y + row) * stride + (size_t)x * 4, px + (size_t)row * w * 4,
           (size_t)w * 4);
  struct rect r = {(int32_t)x, (int32_t)y, (int32_t)w, (int32_t)hh};
  rect_union(&st.damage, r);
  for (int i = 0; i < NBUF; i++) rect_union(&st.bufs[i].stale, r);
  st.stat_frames++;
  st.stat_bytes += len;
}

static void handle_command(const uint32_t *h, const uint8_t *payload, uint32_t len) {
  switch (h[1]) {
  case CMD_SHOW: {
    char name[MAX_NAME + 1];
    if (len > MAX_NAME) {
      emit_error("output name too long");
      return;
    }
    memcpy(name, payload, len);
    name[len] = '\0';
    surface_create(name);
    break;
  }
  case CMD_HIDE:
    surface_destroy();
    break;
  case CMD_FRAME:
    handle_frame(h, payload, len);
    emit_simple("ready");
    break;
  case CMD_QUIT:
    st.running = false;
    break;
  default:
    emit_error("unknown command");
  }
}

static void read_stdin(void) {
  for (;;) {
    if (st.in_cap - st.in_len < 65536) {
      size_t cap = MAX(st.in_cap * 2, (size_t)1 << 20);
      if (cap > MAX_PAYLOAD + HDR_BYTES + 65536) cap = MAX_PAYLOAD + HDR_BYTES + 65536;
      if (cap <= st.in_cap) {
        emit_error("input overflow");
        exit(1);
      }
      uint8_t *p = realloc(st.in, cap);
      if (!p) exit(1);
      st.in = p;
      st.in_cap = cap;
    }
    ssize_t n = read(STDIN_FILENO, st.in + st.in_len, st.in_cap - st.in_len);
    if (n == 0) {
      st.running = false; // parent closed the pipe / died
      return;
    }
    if (n < 0) {
      if (errno == EINTR) continue;
      if (errno == EAGAIN) break;
      st.running = false;
      return;
    }
    st.in_len += (size_t)n;
  }

  size_t off = 0;
  while (st.in_len - off >= HDR_BYTES) {
    uint32_t h[HDR_WORDS];
    memcpy(h, st.in + off, HDR_BYTES);
    if (h[0] != MAGIC || h[2] > MAX_PAYLOAD) {
      emit_error("protocol desync");
      exit(1);
    }
    if (st.in_len - off < HDR_BYTES + (size_t)h[2]) break; // wait for the rest
    handle_command(h, st.in + off + HDR_BYTES, h[2]);
    off += HDR_BYTES + h[2];
  }
  if (off > 0) {
    memmove(st.in, st.in + off, st.in_len - off);
    st.in_len -= off;
  }
}

// ----------------------------------------------------------------- registry

static void registry_global(void *data, struct wl_registry *reg, uint32_t name,
                            const char *iface, uint32_t version) {
  (void)data;
  // never bind newer than what the *runtime* libwayland-client understands,
  // otherwise unknown events would kill the connection
  if (strcmp(iface, wl_compositor_interface.name) == 0) {
    st.compositor = wl_registry_bind(reg, name, &wl_compositor_interface,
                                     MIN(version, (uint32_t)MIN(wl_compositor_interface.version, 6)));
  } else if (strcmp(iface, wl_shm_interface.name) == 0) {
    st.shm = wl_registry_bind(reg, name, &wl_shm_interface, 1);
  } else if (strcmp(iface, zwlr_layer_shell_v1_interface.name) == 0) {
    st.layer_shell = wl_registry_bind(reg, name, &zwlr_layer_shell_v1_interface, MIN(version, 4));
  } else if (strcmp(iface, zxdg_output_manager_v1_interface.name) == 0) {
    st.xdg_output_manager =
        wl_registry_bind(reg, name, &zxdg_output_manager_v1_interface, MIN(version, 3));
    struct output *o;
    wl_list_for_each(o, &st.outputs, link) output_attach_xdg(o);
  } else if (strcmp(iface, wp_viewporter_interface.name) == 0) {
    st.viewporter = wl_registry_bind(reg, name, &wp_viewporter_interface, 1);
  } else if (strcmp(iface, wp_fractional_scale_manager_v1_interface.name) == 0) {
    st.fractional_manager =
        wl_registry_bind(reg, name, &wp_fractional_scale_manager_v1_interface, 1);
  } else if (strcmp(iface, wl_output_interface.name) == 0) {
    struct output *o = calloc(1, sizeof *o);
    if (!o) return;
    o->global_name = name;
    o->scale = 1;
    o->wl = wl_registry_bind(reg, name, &wl_output_interface,
                             MIN(version, (uint32_t)MIN(wl_output_interface.version, 4)));
    wl_output_add_listener(o->wl, &output_listener, o);
    wl_list_insert(&st.outputs, &o->link);
    output_attach_xdg(o);
    // wl_output < v4 has no name: fall back to a stable synthetic one
    snprintf(o->name, sizeof o->name, "wl_output-%u", name);
  }
}

static void registry_global_remove(void *data, struct wl_registry *reg, uint32_t name) {
  (void)data, (void)reg;
  struct output *o, *tmp;
  wl_list_for_each_safe(o, tmp, &st.outputs, link) {
    if (o->global_name == name) {
      output_destroy(o);
      emit_outputs();
      return;
    }
  }
}

static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_global_remove,
};

// --------------------------------------------------------------------- main

static void on_signal(int sig) {
  (void)sig;
  st.running = false;
}

static void debug_stats(void) {
  if (!st.debug) return;
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  double dt = (double)(now.tv_sec - st.stat_t0.tv_sec) + (now.tv_nsec - st.stat_t0.tv_nsec) / 1e9;
  if (dt < 1.0) return;
  struct output *o = st.entered ? st.entered : st.target;
  dbg("output=%s frames/s=%.1f commits/s=%.1f MB/s=%.1f", o ? o->name : "?", st.stat_frames / dt,
      st.stat_commits / dt, st.stat_bytes / dt / 1e6);
  st.stat_frames = st.stat_commits = st.stat_bytes = 0;
  st.stat_t0 = now;
}

int main(int argc, char **argv) {
  bool probe = argc > 1 && strcmp(argv[1], "--probe") == 0;
  st.probe = probe;
  st.debug = getenv("USPWIP_WL_DEBUG") != NULL;
  wl_list_init(&st.outputs);

  st.display = wl_display_connect(NULL);
  if (!st.display) {
    if (probe) printf("{\"wayland\":false}\n");
    return 1;
  }
  st.registry = wl_display_get_registry(st.display);
  wl_registry_add_listener(st.registry, &registry_listener, NULL);
  wl_display_roundtrip(st.display); // globals
  wl_display_roundtrip(st.display); // output + xdg-output state

  bool ok = st.compositor && st.shm && st.layer_shell;
  if (probe) {
    int n = 0;
    struct output *o;
    wl_list_for_each(o, &st.outputs, link) n++;
    printf("{\"wayland\":true,\"layerShell\":%s,\"viewporter\":%s,\"fractionalScale\":%s,"
           "\"xdgOutput\":%s,\"outputs\":%d}\n",
           st.layer_shell ? "true" : "false", st.viewporter ? "true" : "false",
           st.fractional_manager ? "true" : "false", st.xdg_output_manager ? "true" : "false", n);
    return ok ? 0 : 2;
  }
  if (!ok) {
    emit_error("compositor lacks wlr-layer-shell");
    return 2;
  }

  prctl(PR_SET_PDEATHSIG, SIGTERM);
  signal(SIGPIPE, SIG_IGN);
  struct sigaction sa = {.sa_handler = on_signal};
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
  clock_gettime(CLOCK_MONOTONIC, &st.stat_t0);

  emit_outputs();
  emit_simple("hello");

  st.running = true;
  int wl_fd = wl_display_get_fd(st.display);
  while (st.running) {
    while (wl_display_prepare_read(st.display) != 0) wl_display_dispatch_pending(st.display);
    bool want_write = wl_display_flush(st.display) < 0 && errno == EAGAIN;
    struct pollfd fds[2] = {
        {.fd = wl_fd, .events = POLLIN | (want_write ? POLLOUT : 0)},
        {.fd = STDIN_FILENO, .events = POLLIN},
    };
    int r = poll(fds, 2, st.debug ? 1000 : -1);
    if (r < 0 && errno != EINTR) {
      wl_display_cancel_read(st.display);
      break;
    }
    if (r > 0 && (fds[0].revents & POLLIN)) {
      if (wl_display_read_events(st.display) < 0) break;
    } else {
      wl_display_cancel_read(st.display);
    }
    if (wl_display_dispatch_pending(st.display) < 0) break;
    if (r > 0 && (fds[0].revents & (POLLERR | POLLHUP))) break;
    if (r > 0 && (fds[1].revents & (POLLIN | POLLHUP | POLLERR))) read_stdin();
    try_commit();
    debug_stats();
  }

  int err = wl_display_get_error(st.display);
  surface_destroy();
  wl_display_flush(st.display);
  if (err) {
    char msg[96];
    snprintf(msg, sizeof msg, "wayland connection error %d", err);
    emit_error(msg);
    return 3;
  }
  return 0;
}
