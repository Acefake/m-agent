import { IsString, IsArray, ArrayMaxSize, IsIn, MaxLength, IsNotEmpty, IsOptional } from "../preload/class-validator";

export class RequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  requestId!: string;
}

export class BeginDto extends RequestDto {
  @IsString()
  @MaxLength(2048)
  url!: string;

  @IsString()
  body!: string;

  /**
   * 请求方法：POST（chat/completions，缺省）或 GET（models 列表）。
   * 只允许渲染层传这两个值，非法值在 validateRequest 里按无效请求拒绝。
   */
  @IsOptional()
  @IsIn(["GET", "POST"])
  method?: string;

  /**
   * 供应商要求的额外请求头（如 OpenCode Go 的 x-opencode-session）。
   * 只允许普通头，数目与长度都有上限；保留头与非法名在 validateRequest 里剔除。
   */
  @IsOptional()
  extraHeaders?: Record<string, string>;
}

export class CreateNodeDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  parentId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsString()
  @IsNotEmpty()
  metaclass!: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(16)
  stereotypes!: string[];

  @IsIn(["true", "false"])
  hasSysMLPermission!: string;
}
