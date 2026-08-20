import { Routes, Route, Navigate } from 'react-router-dom';
import AppShell from './components/AppShell';
import RequireAuth from './auth/RequireAuth';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import LobbyPage from './pages/LobbyPage';
import SwipePage from './pages/SwipePage';
import CharacterDetailPage from './pages/CharacterDetailPage';
import GoSteadyPage from './pages/GoSteadyPage';
import ProfilePage from './pages/ProfilePage';
import SubscriptionPage from './pages/SubscriptionPage';
import ChatPage from './pages/ChatPage';
import NotFoundPage from './pages/NotFoundPage';
import AdminShell from './admin/AdminShell';
import RequireAdmin from './admin/RequireAdmin';
import AdminPlaceholder from './admin/AdminPlaceholder';
import AdminHomePage from './pages/admin/AdminHomePage';
import ContentReviewPage from './pages/admin/ContentReviewPage';
import ContentLibraryPage from './pages/admin/ContentLibraryPage';
import ContentSettingsPage from './pages/admin/ContentSettingsPage';
import AdminCharactersPage from './pages/admin/AdminCharactersPage';
import AdminCharacterDetailPage from './pages/admin/AdminCharacterDetailPage';

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
      {/*
        US-99 — the single /admin operator shell. It sits OUTSIDE AppShell
        because AppShell is a max-w-lg consumer frame; admin work is desktop
        work. This is one admin product, not a second SPA: every Epic 11 area
        plugs in as a child route here.
      */}
      <Route
        path="/admin"
        element={
          <RequireAdmin>
            <AdminShell />
          </RequireAdmin>
        }
      >
        <Route index element={<AdminHomePage />} />
        <Route path="content/review" element={<ContentReviewPage />} />
        <Route path="content/library" element={<ContentLibraryPage />} />
        {/* US-101 — character identity management. */}
        <Route path="characters" element={<AdminCharactersPage />} />
        <Route path="characters/:characterId" element={<AdminCharacterDetailPage />} />
        {/* Content requirements — the configuration the Review board reads. */}
        <Route path="settings/content-requirements" element={<ContentSettingsPage />} />
        <Route path="publishing" element={<AdminPlaceholder destination="publishing" />} />
        <Route path="generation" element={<AdminPlaceholder destination="generation" />} />
      </Route>

      <Route element={<AppShell />}>
        {/* Discover is the primary entry point */}
        <Route path="/" element={<Navigate to="/characters" replace />} />

        {/* Primary destination: the v2 media-rich Lobby & Discovery Hub (US-28) */}
        <Route path="/characters" element={<LobbyPage />} />
        <Route path="/go-steady" element={<GoSteadyPage />} />
        <Route path="/profile" element={<ProfilePage />} />

        {/* Swipe discovery (US-19) preserved as a secondary interaction */}
        <Route path="/discover/swipe" element={<SwipePage />} />

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
