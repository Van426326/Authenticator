<template>
  <div class="control-group">
    <label :for="inputId" class="combo-label" style="margin: 20px 10px">{{
      label
    }}</label>
    <select
      :id="inputId"
      style="margin: 20px 10px"
      :value="value"
      :disabled="disabled"
      @input="$emit('input', $event.target.value)"
      @change="$emit('change')"
    >
      <slot></slot>
    </select>
  </div>
</template>
<script lang="ts">
import Vue from "vue";

let nextInputId = 0;

export default Vue.extend({
  props: ["label", "value", "disabled"],
  data() {
    nextInputId += 1;
    return {
      inputId: `select-input-${nextInputId}`,
    };
  },
});
</script>
