<template>
  <div>
    <label :for="inputId">{{ label }}</label>
    <input
      :id="inputId"
      :type="type ? type : 'text'"
      class="input"
      :value="value"
      :disabled="disabled"
      @input="$emit('input', $event.target.value)"
      @keyup.enter="$emit('enter')"
      ref="textInput"
    />
  </div>
</template>
<script lang="ts">
import Vue from "vue";

let nextInputId = 0;

export default Vue.extend({
  props: ["label", "value", "type", "autofocus", "disabled"],
  data() {
    nextInputId += 1;
    return {
      inputId: `text-input-${nextInputId}`,
    };
  },
  mounted() {
    if (!this.$props.autofocus) {
      return;
    }
    const textInput = this.$refs.textInput;
    if (textInput instanceof HTMLInputElement) {
      textInput.focus();
    }
  },
});
</script>
