import { ApiProperty } from '@nestjs/swagger';

/**
 * The shape rendered to the client. Carries no key material — only the
 * provider, last 4 chars, label, and lifecycle timestamps. The full key
 * never leaves the service boundary.
 */
export class ByokResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  provider!: string;

  @ApiProperty({ description: 'Last four characters of the plaintext key.' })
  last4!: string;

  @ApiProperty({ required: false, nullable: true })
  label!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', required: false, nullable: true })
  validatedAt!: string | null;

  @ApiProperty({ format: 'date-time', required: false, nullable: true })
  revokedAt!: string | null;
}
