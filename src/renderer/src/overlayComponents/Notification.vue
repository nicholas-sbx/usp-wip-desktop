<script setup>
import MaskedText from '../components/MaskedText.vue'

defineProps({
  notification: Object
})
</script>

<template>
  <div class="notification">
    <MaskedText
      :text="notification.content"
      :mask="notification.mask"
      :mask-color="notification.colors.text"
    />
  </div>
</template>

<style scoped>
.notification {
  font-weight: bold;
  background-color: v-bind('notification.colors.background');
  padding: 5px 10px 5px 10px;
  font-size: 24px;
  border: 5px solid v-bind('notification.colors.border');
  color: v-bind('notification.colors.text');
  /* the inset box shadow + text shadow are meant to make lighter colors easier to read */
  box-shadow:
    0 0 30px -10px v-bind('notification.colors.shadow'),
    inset 0 0 10px 0px rgba(0, 0, 0, 0.1);
  text-shadow: 0 0 4px rgba(0, 0, 0, 0.1);
  border-radius: 16px;
  margin-bottom: 16px;
  width: max-content;
}
</style>
