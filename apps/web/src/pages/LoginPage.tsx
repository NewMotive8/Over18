import AuthForm from '../components/AuthForm';
import { useAuth } from '../auth/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();
  return <AuthForm mode="login" onSubmit={login} />;
}
