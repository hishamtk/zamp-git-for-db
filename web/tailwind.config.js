/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        border: "#252a31",
        background: "#0b0d10",
        foreground: "#f4f5f6",
        muted: "#9198a1",
        panel: "#111419",
        accent: "#73e2a7",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui"],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(115,226,167,.15), 0 16px 60px rgba(0,0,0,.35)",
      },
    },
  },
  plugins: [],
};
