import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/AppShell';
import RequireAuth from './auth/RequireAuth';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import CharactersPage from './pages/CharactersPage';
import CharacterDetailPage from './pages/CharacterDetailPage';
import GoSteadyPage from './pages/GoSteadyPage';
import ProfilePage from './pages/ProfilePage';
import SubscriptionPage from './pages/SubscriptionPage';
import ChatPage from './pages/ChatPage';
import NotFoundPage from './pages/NotFoundPage';

/**
 * Application routes (US-18).
 *
 * Every screen renders inside the persistent AppShell. The three primary
 * destinations are Discover (`/characters`, the existing lobby — reused, not
 * duplicated), Go Steady (`/go-steady`) and Profile (`/profile`). Root redirects
 * to Discover, the primary entry point. Character profile, chat, auth, the
 * subscription placeholder, and the not-found fallback are all preserved.
 */
export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {/* Discover is the primary entry point */}
        <Route path="/" element={<Navigate to="/characters" replace />} />

        {/* Primary destinations */}
        <Route path="/characters" element={<CharactersPage />} />
        <Route path="/go-steady" element={<GoSteadyPage />} />
        <Route path="/profile" element={<ProfilePage />} />

        {/* Character profile (existing flow, preserved) */}
        <Route path="/characters/:characterId" element={<CharacterDetailPage />} />

        {/* Premium / subscription placeholder (no billing) */}
        <Route path="/subscription" element={<SubscriptionPage />} />

        {/* Auth */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* Chat (existing, auth-gated) */}
        <Route
          path="/chat/:conversationId"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />

        {/* Fallback — never crashes */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
