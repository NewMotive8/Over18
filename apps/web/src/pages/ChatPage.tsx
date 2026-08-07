import { useParams } from 'react-router-dom';
import PagePlaceholder from '../components/PagePlaceholder';

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  return (
    <PagePlaceholder
      title="Chat"
      subtitle={`Conversation "${conversationId}" — messaging arrives in a later story.`}
    />
  );
}
