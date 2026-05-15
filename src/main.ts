import { mount } from "svelte";
import "./styles/sakya.css";
import "./styles/cobweb.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app");

const app = mount(App, { target });
export default app;
