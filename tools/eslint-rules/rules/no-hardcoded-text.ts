import type { Rule } from 'eslint';

/**
 * `@nx/workspace-no-hardcoded-text` (#4): every user-facing string in a console template goes through i18n.
 *
 * Reports, in Angular templates (`.html` files and inline `template:`s, through angular-eslint's parser):
 * - text between tags that contains a letter (`<h1>Settings</h1>`, `Hello {{ name }}`);
 * - a string literal that would be rendered as is (`{{ 'Settings' }}`, `{{ busy ? 'Wait' : '' }}`);
 * - a static user-facing attribute with a letter in it (`title`, `alt`, `placeholder`, `aria-label`, …) or such an
 *   attribute bound to a literal (`[attr.aria-label]="'Close'"`).
 * A literal that goes into a pipe or a call (`'settings.title' | transloco`, `t('settings.title')`) is a key, not
 * copy, and passes. Text with no letter at all (`·`, `—`, `3`) passes too.
 *
 * The rule only acts on Angular template nodes, so it is safe to switch on for every file.
 */

/** Attributes and component inputs whose value a user reads or a screen reader speaks. */
export const USER_FACING_ATTRIBUTES: readonly string[] = [
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'caption',
  'description',
  'heading',
  'hint',
  'label',
  'message',
  'placeholder',
  'subtitle',
  'summary',
  'title',
  'tooltip',
];

/** Elements whose text is not copy: key caps (`<kbd>K</kbd>`) and code (`<code>/p/{{ slug }}</code>`). */
export const NON_COPY_ELEMENTS: readonly string[] = ['code', 'kbd'];

const LETTER = /\p{L}/u;

const RENDERING_OPERATORS: ReadonlySet<string> = new Set(['+', '??', '||', '&&']);

/** The slice of angular-eslint's template AST this rule reads; the parser hands over the compiler's own nodes. */
interface SourceSpan {
  readonly start: { readonly offset: number };
  readonly end: { readonly offset: number };
}

interface TemplateNode {
  readonly sourceSpan: SourceSpan;
  /** Set by ESLint's traversal: the enclosing node (an `Element` has a `name`). */
  readonly parent?: { readonly type?: string; readonly name?: unknown; readonly parent?: unknown } | null;
}

interface TextNode extends TemplateNode {
  readonly value: string;
}

interface ExpressionNode {
  readonly type?: string;
  readonly constructor: { readonly name: string };
  readonly [key: string]: unknown;
}

interface WithSource {
  readonly ast?: ExpressionNode;
}

interface BoundTextNode extends TemplateNode {
  readonly value: WithSource;
}

interface AttributeNode extends TemplateNode {
  readonly name: string;
  readonly value: string;
}

interface BoundAttributeNode extends TemplateNode {
  readonly name: string;
  readonly value: WithSource | null;
}

interface TemplateParserServices {
  convertNodeSourceSpanToLoc(span: SourceSpan): {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
}

export function hasLetter(text: string): boolean {
  return LETTER.test(text);
}

function kindOf(node: ExpressionNode): string {
  // The template parser stamps `type` with the class name; Angular's own numeric `type` fields are moved aside.
  return typeof node.type === 'string' ? node.type : node.constructor.name;
}

function isExpression(value: unknown): value is ExpressionNode {
  return typeof value === 'object' && value !== null;
}

/**
 * String literals in `expression` that reach the screen as they are. Pipes and calls take keys, not copy, so the
 * walk stops there; a conditional, a `??`/`||` fallback, a concatenation or a template literal is walked through.
 */
export function renderedLiterals(expression: ExpressionNode | undefined): string[] {
  if (expression === undefined) {
    return [];
  }
  const kind = kindOf(expression);
  const child = (name: string): string[] => {
    const value = expression[name];
    return isExpression(value) ? renderedLiterals(value) : [];
  };
  switch (kind) {
    case 'LiteralPrimitive':
      return typeof expression['value'] === 'string' ? [expression['value']] : [];
    case 'ASTWithSource':
      return child('ast');
    case 'ParenthesizedExpression':
      return child('expression');
    case 'Conditional':
      return [...child('trueExp'), ...child('falseExp')];
    case 'Binary':
      // A comparison renders a boolean; a concatenation or a fallback renders its operands.
      return RENDERING_OPERATORS.has(String(expression['operation']))
        ? [...child('left'), ...child('right')]
        : [];
    case 'Interpolation': {
      const expressions = expression['expressions'];
      return Array.isArray(expressions)
        ? expressions.filter(isExpression).flatMap((item) => renderedLiterals(item))
        : [];
    }
    case 'TemplateLiteral': {
      const elements = expression['elements'];
      const quasis = Array.isArray(elements)
        ? elements.flatMap((element: unknown) =>
            isExpression(element) && typeof element['text'] === 'string' ? [element['text']] : [],
          )
        : [];
      const expressions = expression['expressions'];
      return [
        ...quasis,
        ...(Array.isArray(expressions)
          ? expressions.filter(isExpression).flatMap((item) => renderedLiterals(item))
          : []),
      ];
    }
    default:
      return [];
  }
}

function insideNonCopyElement(node: TemplateNode): boolean {
  let current: unknown = node.parent;
  while (typeof current === 'object' && current !== null) {
    const ancestor = current as {
      readonly type?: unknown;
      readonly name?: unknown;
      readonly parent?: unknown;
    };
    if (
      ancestor.type === 'Element' &&
      typeof ancestor.name === 'string' &&
      NON_COPY_ELEMENTS.includes(ancestor.name)
    ) {
      return true;
    }
    current = ancestor.parent;
  }
  return false;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

export const RULE_NAME = 'no-hardcoded-text';

export const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hard-coded user-facing text in Angular templates; copy lives in ru.json/en.json (#4, ADR 0002).',
    },
    schema: [
      {
        type: 'object',
        properties: {
          attributes: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      text: 'Hard-coded text "{{text}}": put it in ru.json and en.json and render it with transloco.',
      attribute:
        'Hard-coded {{name}}="{{text}}": put it in ru.json and en.json and bind it, e.g. [attr.{{name}}]="\'key\' | transloco".',
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices as Partial<TemplateParserServices> | undefined;
    const toLoc = services?.convertNodeSourceSpanToLoc;
    if (typeof toLoc !== 'function') {
      // Not an Angular template (a .ts file, a worker lib): nothing to check.
      return {};
    }
    const option = (context.options[0] ?? {}) as { attributes?: readonly string[] };
    const attributes = new Set([...USER_FACING_ATTRIBUTES, ...(option.attributes ?? [])]);
    const loc = (node: TemplateNode) => toLoc.call(services, node.sourceSpan);

    const reportText = (node: TemplateNode, text: string): void => {
      context.report({ loc: loc(node), messageId: 'text', data: { text: excerpt(text) } });
    };
    const reportAttribute = (node: TemplateNode, name: string, text: string): void => {
      context.report({ loc: loc(node), messageId: 'attribute', data: { name, text: excerpt(text) } });
    };

    return {
      Text(node: unknown) {
        const text = node as TextNode;
        if (hasLetter(text.value) && !insideNonCopyElement(text)) {
          reportText(text, text.value);
        }
      },
      BoundText(node: unknown) {
        const bound = node as BoundTextNode;
        const ast = bound.value.ast;
        if (ast === undefined || insideNonCopyElement(bound)) {
          return;
        }
        const strings = ast['strings'];
        const literalParts = Array.isArray(strings)
          ? strings.filter((part): part is string => typeof part === 'string')
          : [];
        for (const text of [...literalParts, ...renderedLiterals(ast)]) {
          if (hasLetter(text)) {
            reportText(bound, text);
          }
        }
      },
      TextAttribute(node: unknown) {
        const attribute = node as AttributeNode;
        if (attributes.has(attribute.name) && hasLetter(attribute.value)) {
          reportAttribute(attribute, attribute.name, attribute.value);
        }
      },
      BoundAttribute(node: unknown) {
        const attribute = node as BoundAttributeNode;
        if (!attributes.has(attribute.name)) {
          return;
        }
        for (const text of renderedLiterals(attribute.value?.ast)) {
          if (hasLetter(text)) {
            reportAttribute(attribute, attribute.name, text);
          }
        }
      },
    };
  },
};
