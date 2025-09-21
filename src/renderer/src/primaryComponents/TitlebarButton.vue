<script setup></script>

<template>
  <div class="titlebarButton">
    <slot></slot>
  </div>
</template>

<style scoped>
.titlebarButton {
  -webkit-app-region: no-drag;
  min-width: 50px;
  text-align: center;
  background-color: #00000011;
  padding: 5px 10px 5px 10px;
  box-sizing: border-box;
}

.titlebarButton:hover {
  background-color: #00000033;
}

.titlebarButton:active {
  background-color: #00000055;
}
</style>
