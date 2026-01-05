# Azure IC Demos

A React application powered by Vite showcasing various Azure IC demo cards.

## Getting Started

Install dependencies:
```
npm install
```

Run the development server:
```
npm run dev
```

Browse the app at [http://localhost:5173](http://localhost:5173).

## Project Structure

- `src/demoData.json`: Definitions for demo cards including title, category, description, and links.
- `src/App.jsx`: Main layout rendering dynamic cards based on JSON data.
- `src/App.css`: Styling for the demo cards and layout.

Feel free to customize the data and styling to fit your needs.

## React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
