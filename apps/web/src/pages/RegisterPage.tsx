import AuthForm from '../components/AuthForm';
import { useAuth } from '../auth/AuthContext';

export default function RegisterPage() {
  const { register } = useAuth();
  return <AuthForm mode="register" onSubmit={register} />;
}
