import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const SUPPORTED_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'groq',
] as const;

export class ByokCreateDto {
  @ApiProperty({ enum: SUPPORTED_PROVIDERS })
  @IsIn(SUPPORTED_PROVIDERS as unknown as string[])
  provider!: (typeof SUPPORTED_PROVIDERS)[number];

  @ApiProperty({ minLength: 16, description: 'Plaintext key. Never logged.' })
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  key!: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;
}
