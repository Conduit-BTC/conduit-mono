import conduitPreset from "../../packages/ui/tailwind.preset.js"

/** @type {import('tailwindcss').Config} */
export default {
  presets: [conduitPreset],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    "../../packages/ui/src/**/*.{js,ts,jsx,tsx}",
  ],
}
