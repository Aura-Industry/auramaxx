import fs from 'fs';
import path from 'path';

export interface AppManifest {
  id: string;
  name: string;
  icon: string;
  category: string;
  size: { width: number; height: number };
  permissions: string[];
  data: string[];
  description: string;
  path: string;
  hasUi: boolean;
}

/**
 * Parse simple YAML frontmatter from app.md
 * Handles key: value lines and arrays (- item)
 */
function parseFrontmatter(content: string): Record<string, unknown> {
  const lines = content.split('\n');
  const result: Record<string, unknown> = {};

  let inFrontmatter = false;
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '---') {
      if (inFrontmatter) break; // End of frontmatter
      inFrontmatter = true;
      continue;
    }

    if (!inFrontmatter) continue;

    // Array item
    if (trimmed.startsWith('- ') && currentKey) {
      if (!currentArray) currentArray = [];
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }

    // Save previous array
    if (currentKey && currentArray) {
      result[currentKey] = currentArray;
      currentArray = null;
      currentKey = null;
    }

    // Key: value line
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      if (value === '' || value === '[]') {
        // Start of array or empty value or inline empty array
        currentKey = key;
        currentArray = [];
      } else {
        result[key] = value;
        currentKey = null;
      }
    }
  }

  // Save trailing array
  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }

  return result;
}

/**
 * Extract description from markdown body (after frontmatter)
 */
function extractDescription(content: string): string {
  const parts = content.split('---');
  if (parts.length < 3) return '';
  // Everything after the second --- is the body
  const body = parts.slice(2).join('---').trim();
  // Take first paragraph
  const firstParagraph = body.split('\n\n')[0];
  return firstParagraph.replace(/^#+\s*/, '').trim();
}

/**
 * Parse size string like "2x2" into { width, height }
 * Grid units: 1 = 320px width, 280px height
 */
function parseSize(size: string): { width: number; height: number } {
  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) return { width: 320, height: 280 };
  return {
    width: parseInt(match[1]) * 320,
    height: parseInt(match[2]) * 280,
  };
}

/**
 * Load all app manifests from the apps/ directory
 */
export function loadAppManifests(): AppManifest[] {
  const appsDir = path.join(process.cwd(), 'apps');

  if (!fs.existsSync(appsDir)) return [];

  const manifests: AppManifest[] = [];

  const entries = fs.readdirSync(appsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const appMdPath = path.join(appsDir, entry.name, 'app.md');
    const indexHtmlPath = path.join(appsDir, entry.name, 'index.html');

    if (!fs.existsSync(appMdPath)) continue;
    const hasUi = fs.existsSync(indexHtmlPath);

    try {
      const content = fs.readFileSync(appMdPath, 'utf-8');
      const fm = parseFrontmatter(content);
      const description = extractDescription(content);

      manifests.push({
        id: entry.name,
        name: (fm.name as string) || entry.name,
        icon: (fm.icon as string) || 'Box',
        category: (fm.category as string) || 'general',
        size: parseSize((fm.size as string) || '1x1'),
        permissions: (fm.permissions as string[]) || [],
        data: (fm.data as string[]) || [],
        description,
        path: entry.name,
        hasUi,
      });
    } catch (err) {
      console.error(`[app-loader] Failed to load app ${entry.name}:`, err);
    }
  }

  return manifests;
}
