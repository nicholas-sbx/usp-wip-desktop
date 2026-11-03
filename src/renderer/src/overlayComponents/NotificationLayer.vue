<script setup>
import { inject } from 'vue'
import Notification from './Notification.vue'
const notifications = inject('notifications')
</script>

<template>
  <div class="notificationLayer">
    <TransitionGroup name="notif-list">
      <Notification
        v-for="notification in notifications"
        :key="notification.id"
        :notification="notification"
      />
    </TransitionGroup>
  </div>
</template>

<style scoped>
.notificationLayer {
  z-index: var(--notification-z-index);
  position: fixed;
  top: 30px;
  left: 30px;
}

/* the below classes control to the Vue TransitionGroup animations */

.notif-list-move,
.notif-list-enter-active,
.notif-list-leave-active {
  transition: all 200ms ease;
}

.notif-list-enter-from,
.notif-list-leave-to {
  opacity: 0;
  /* transform: translateX(-30px); */
}

.notif-list-leave-active {
  position: absolute;
}
</style>
