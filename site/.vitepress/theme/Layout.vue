<script setup lang="ts">
// The home page is the product's front door and not a docs page: `layout: landing` renders Landing.vue alone.
// Everything else is the default theme.
import DefaultTheme from "vitepress/theme";
import { useData } from "vitepress";
import Landing from "./Landing.vue";
const { frontmatter } = useData();
</script>

<template>
  <Landing v-if="frontmatter.layout === 'landing'" />
  <DefaultTheme.Layout v-else />
</template>
