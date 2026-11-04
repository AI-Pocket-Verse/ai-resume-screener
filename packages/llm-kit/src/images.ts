// HTTP 通道的读图:把本地页图读成 base64,随请求体发给模型。
// CLI 通道让模型自己用 Read 工具读图,HTTP 通道没有工具,只能由调用方把图片内联进消息。
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

const MEDIA_TYPES: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export interface InlineImage {
  mediaType: ImageMediaType;
  base64: string;
}

/** 按扩展名判定类型。不认识的扩展名直接报错:发一张类型标错的图给模型,
 *  厂商通常只回一句含糊的 400,不如在这里说清楚。 */
export async function readInlineImages(paths: string[]): Promise<InlineImage[]> {
  return Promise.all(
    paths.map(async (p) => {
      const mediaType = MEDIA_TYPES[extname(p).toLowerCase()];
      if (!mediaType) throw new Error(`不支持的图片类型: ${extname(p) || "(无扩展名)"}`);
      return { mediaType, base64: (await readFile(p)).toString("base64") };
    }),
  );
}
