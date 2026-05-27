import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.context';
import { ProblemException } from '../common/problem';
import { PrismaService } from '../prisma/prisma.service';

interface NeighborDto {
  chunkId: string;
  ordinal: number;
  page: number | null;
  content: string;
}

interface ChunkDetailDto {
  chunkId: string;
  ordinal: number;
  page: number | null;
  slide: number | null;
  cell: number | null;
  charStart: number;
  charEnd: number;
  content: string;
  documentId: string;
  documentFilename: string;
  documentMime: string;
  versionId: string;
  meta: Record<string, unknown> | null;
  neighbors: { prev: NeighborDto | null; next: NeighborDto | null };
}

@ApiTags('chunks')
@Controller('chunks')
export class ChunksController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Resolve a chunk to its content + source-document metadata for the citation preview pane.',
  })
  async detail(
    @CurrentUser() user: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ChunkDetailDto> {
    const chunk = await this.prisma.chunk.findUnique({
      where: { id },
      include: {
        documentVersion: { include: { document: true } },
      },
    });
    if (
      !chunk ||
      chunk.documentVersion.document.tenantId !== user.tenantId ||
      chunk.documentVersion.document.deletedAt !== null
    ) {
      // Tenant scoping: chunks from another account simply look "not found".
      // Documents in Trash are off-limits too; the user can restore the doc
      // first if they actually want to inspect a deleted-doc citation.
      throw new ProblemException({
        status: 404,
        code: 'chunks.not-found',
        title: 'Chunk not found',
      });
    }

    // Pull the immediate neighbors (same document version, adjacent ordinals)
    // so the preview can show what came before/after. Cheap — at most two
    // rows. We don't paginate the whole chunk list here; this is a
    // citation peek, not a document reader.
    const [prev, next] = await Promise.all([
      this.prisma.chunk.findFirst({
        where: {
          documentVersionId: chunk.documentVersionId,
          ordinal: { lt: chunk.ordinal },
        },
        orderBy: { ordinal: 'desc' },
      }),
      this.prisma.chunk.findFirst({
        where: {
          documentVersionId: chunk.documentVersionId,
          ordinal: { gt: chunk.ordinal },
        },
        orderBy: { ordinal: 'asc' },
      }),
    ]);

    return {
      chunkId: chunk.id,
      ordinal: chunk.ordinal,
      page: chunk.page,
      slide: chunk.slide,
      cell: chunk.cell,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      content: chunk.content,
      documentId: chunk.documentVersion.document.id,
      documentFilename: chunk.documentVersion.document.originalFilename,
      documentMime: chunk.documentVersion.document.mime,
      versionId: chunk.documentVersion.id,
      meta: (chunk.meta as Record<string, unknown> | null) ?? null,
      neighbors: {
        prev: prev
          ? {
              chunkId: prev.id,
              ordinal: prev.ordinal,
              page: prev.page,
              content: prev.content,
            }
          : null,
        next: next
          ? {
              chunkId: next.id,
              ordinal: next.ordinal,
              page: next.page,
              content: next.content,
            }
          : null,
      },
    };
  }
}
