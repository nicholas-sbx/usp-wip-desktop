# Builds the native Wayland layer-shell overlay helper.
# Build deps (Debian/Ubuntu): gcc make pkg-config libwayland-dev (provides wayland-scanner)
# Runtime deps: libwayland-client.so.0 (present on every Wayland desktop)

CC ?= cc
PKG_CONFIG ?= pkg-config
WAYLAND_SCANNER ?= $(shell $(PKG_CONFIG) --variable=wayland_scanner wayland-scanner 2>/dev/null || echo wayland-scanner)

BUILD := build
BIN := $(BUILD)/uspwip-wl-overlay
PROTOCOLS := wlr-layer-shell-unstable-v1 xdg-shell xdg-output-unstable-v1 viewporter fractional-scale-v1

GEN_C := $(PROTOCOLS:%=$(BUILD)/%-protocol.c)
GEN_H := $(PROTOCOLS:%=$(BUILD)/%-client-protocol.h)

WL_CFLAGS := $(shell $(PKG_CONFIG) --cflags wayland-client)
WL_LIBS := $(shell $(PKG_CONFIG) --libs wayland-client)

CFLAGS ?= -O2
CFLAGS += -std=c11 -Wall -Wextra -Wno-unused-parameter -I$(BUILD) $(WL_CFLAGS) \
	-fstack-protector-strong -D_FORTIFY_SOURCE=2 -fPIE
LDFLAGS += -pie -Wl,-z,relro,-z,now,-z,noexecstack -Wl,--as-needed
LDLIBS += $(WL_LIBS) -lm

all: $(BIN)

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/%-protocol.c: protocols/%.xml | $(BUILD)
	$(WAYLAND_SCANNER) private-code $< $@

$(BUILD)/%-client-protocol.h: protocols/%.xml | $(BUILD)
	$(WAYLAND_SCANNER) client-header $< $@

$(BIN): uspwip-wl-overlay.c $(GEN_C) $(GEN_H)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ uspwip-wl-overlay.c $(GEN_C) $(LDLIBS)

clean:
	rm -rf $(BUILD)

.PHONY: all clean
