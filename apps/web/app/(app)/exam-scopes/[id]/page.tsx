import { ExamScopeView } from '../../../../components/exam-scope-view';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ExamScopePage({ params }: Props) {
  const { id } = await params;
  return <ExamScopeView scopeId={id} />;
}
