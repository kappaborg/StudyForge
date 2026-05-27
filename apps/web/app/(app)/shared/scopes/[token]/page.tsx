import { AcceptScopeView } from '../../../../../components/accept-scope-view';

interface Props {
  params: Promise<{ token: string }>;
}

export default async function SharedScopePage({ params }: Props) {
  const { token } = await params;
  return <AcceptScopeView token={token} />;
}
