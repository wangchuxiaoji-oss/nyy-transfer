/**
 * 首页 FAQ 数据
 * 可同时被 Server Component（page.tsx 结构化数据）和 Client Component（home-story.tsx UI）导入
 */
import { createHomeFaqs, DEFAULT_QUOTA_POLICY } from "@/lib/quota-policy";

export const HOME_FAQS = createHomeFaqs(DEFAULT_QUOTA_POLICY);
