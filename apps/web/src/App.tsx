import { Routes, Route } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import CharactersPage from './pages/CharactersPage';
import CharacterDetailPage from './pages/CharacterDetailPage';
import ChatPage from './pages/ChatPage';
import NotFoundPage from './pages/NotFoundPage';

export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/characters" element={<CharactersPage />} />
        <Route path="/characters/:characterId" element={<CharacterDetailPage />} />
        <Route path="/chat/:conversationId" element={<ChatPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
