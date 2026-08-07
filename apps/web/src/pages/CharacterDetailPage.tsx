import { useParams } from 'react-router-dom';
import PagePlaceholder from '../components/PagePlaceholder';

export default function CharacterDetailPage() {
  const { characterId } = useParams<{ characterId: string }>();
  return (
    <PagePlaceholder
      title="Character detail"
      subtitle={`Profile for character "${characterId}" — coming in a later story.`}
    />
  );
}
