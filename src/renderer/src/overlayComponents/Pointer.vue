<script setup>
defineProps({
  pointer: Object,
  state: String
})
</script>

<template>
  <svg
    width="150"
    height="150"
    viewBox="0 0 150 150"
    version="1.1"
    class="pointer"
    :class="{ clicking: state === 'clicking', active: state === 'normal' || state === 'clicking' }"
  >
    <path
      id="path1"
      class="pointerPath"
      style="
        display: inline;
        stroke-width: 1px;
        stroke-linecap: butt;
        stroke-linejoin: miter;
        stroke-opacity: 1;
        fill-opacity: 1;
      "
      d="M 75,75 50,130 75,150 100,130 Z"
      inkscape:label="path1"
    />
    <text
      id="text2"
      xml:space="preserve"
      style="
        font-size: 40px;
        line-height: 1.25;
        font-family: sans-serif;
        text-align: center;
        letter-spacing: 0px;
        word-spacing: 0px;
        text-anchor: middle;
      "
      x="75.240021"
      y="132.20212"
    >
      <tspan id="tspan2" sodipodi:role="line" x="75.240021" y="132.20212">
        {{ pointer.number }}
      </tspan>
    </text>
  </svg>
</template>

<style scoped>
.pointer {
  transition: all 100ms linear;
  opacity: 0.2;
}

.clicking {
  transform: rotate3d(1, 0, 0, 40deg);
}

.active {
  opacity: 1;
}

.pointerPath {
  fill: v-bind('pointer.color');
  stroke: #000000;
  filter: drop-shadow(0px 0px 5px rgba(0, 0, 0, 0.1));
  overflow: visible;
}
</style>
