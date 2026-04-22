/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0d12",
        panel: "#141821",
        panel2: "#1c2230",
        ink: "#e6e9ef",
        mute: "#8892a6",
        accent: "#60a5fa",
      },
    },
  },
  plugins: [],
};
