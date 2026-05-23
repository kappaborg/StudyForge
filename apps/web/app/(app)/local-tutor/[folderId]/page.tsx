import { OfflineTutor } from '../../../../components/offline-tutor';

interface Props {
  params: Promise<{ folderId: string }>;
}

export default async function LocalTutorPage({ params }: Props) {
  const { folderId } = await params;
  return <OfflineTutor folderId={folderId} />;
}
