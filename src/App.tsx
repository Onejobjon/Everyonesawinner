import { Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Calculator from "./pages/Calculator";
import Oddsmatcher from "./pages/Oddsmatcher";
import WorldCup from "./pages/WorldCup";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/calculator" element={<Calculator />} />
      <Route path="/oddsmatcher" element={<Oddsmatcher />} />
      <Route path="/world-cup" element={<WorldCup />} />
    </Routes>
  );
}