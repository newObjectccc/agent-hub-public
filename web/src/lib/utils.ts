import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 惯例的 className 合并工具（copy-paste 归项目，可按需定制） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
