import { TutorChat } from '../../../../../components/tutor-chat';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function TutorTabPage({ params }: Props) {
  const { id } = await params;
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold tracking-tight">Tutor</h1>
      <TutorChat folderId={id} />
    </section>
  );
}
