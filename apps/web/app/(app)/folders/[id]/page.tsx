import { FolderView } from '../../../../components/folder-view';

export default async function FolderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <FolderView folderId={id} />;
}
