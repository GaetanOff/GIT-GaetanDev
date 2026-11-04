import { mount } from 'svelte'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/tokens.css'
import './styles/base.css'
import App from './App.svelte'
import { asError } from './lib/api'
import { toast } from './lib/ui.svelte'

// A failure no caller handled is still said, instead of an action that silently did nothing.
window.addEventListener('unhandledrejection', e => {
  e.preventDefault()
  console.error(e.reason)
  toast('error', asError(e.reason).message || 'Something went wrong.')
})

mount(App, { target: document.getElementById('app')! })
