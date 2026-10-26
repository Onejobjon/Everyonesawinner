import { Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import Home from "./pages/Home";
import Calculator from "./pages/Calculator";
import Oddsmatcher from "./pages/Oddsmatcher";
import LayBets from "./pages/LayBets";
import BetBuilder from "./pages/BetBuilder";
import Signup from "./pages/Signup";
import Login from "./pages/Login";
import Logout from "./pages/Logout";
import Dashboard from "./pages/Dashboard";
import Subscribe from "./pages/Subscribe";
import SubscribeSuccess from "./pages/SubscribeSuccess";
import Preview from "./pages/Preview";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/calculator" element={<Calculator />} />
        <Route path="/oddsmatcher" element={<Oddsmatcher />} />
        <Route path="/lay-bets" element={<LayBets />} />
        <Route path="/bet-builder" element={<BetBuilder />} />
        {/* Acca Finder is now the Bet Builder (multi-leg); singles live in /lay-bets */}
        <Route path="/acca-finder" element={<Navigate to="/bet-builder" replace />} />
        {/* World Cup is over — redirect old links to the Lay Bet Finder */}
        <Route path="/world-cup" element={<Navigate to="/lay-bets" replace />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/login" element={<Login />} />
        <Route path="/logout" element={<Logout />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/subscribe" element={<Subscribe />} />
        <Route path="/subscribe/success" element={<SubscribeSuccess />} />
        <Route path="/preview" element={<Preview />} />
      </Routes>
    </AuthProvider>
  );
}
