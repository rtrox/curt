import '@fontsource-variable/space-grotesk';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './app.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { theme } from './lib/theme.svelte.ts';

theme.apply();
const target = document.getElementById('app');
if (!target) throw new Error('missing #app');
mount(App, { target });
