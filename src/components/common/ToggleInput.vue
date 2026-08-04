<template>
  <div class="control-group">
    <label class="combo-label" :for="inputId">{{ label }}</label>
    <input
      :id="inputId"
      class="checkbox"
      type="checkbox"
      :checked="checked"
      :disabled="disabled"
      @change="$emit('change', $event.target.checked)"
    />
  </div>
</template>
<script lang="ts">
import Vue from "vue";

let nextInputId = 0;

export default Vue.extend({
  props: {
    label: String,
    checked: Boolean,
    disabled: Boolean,
  },
  data() {
    nextInputId += 1;
    return {
      inputId: `toggle-input-${nextInputId}`,
    };
  },
  model: {
    prop: "checked",
    event: "change",
  },
});
</script>
