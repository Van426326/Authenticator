<template>
  <div class="import_file">
    <label :for="inputId">{{ label }}</label>
    <input
      :id="inputId"
      type="file"
      v-on="$listeners"
      :accept="accept"
      :multiple="multiple"
      :disabled="disabled"
    />
  </div>
</template>
<script lang="ts">
import Vue from "vue";

let nextInputId = 0;

export default Vue.extend({
  props: ["label", "multiple", "accept", "disabled"],
  data() {
    nextInputId += 1;
    return {
      inputId: `file-input-${nextInputId}`,
    };
  },
});
</script>
