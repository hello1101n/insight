#!/usr/bin/env node
// Finds classes that restyle @gears-frontx/ui-kit components and strips them.
//   node scripts/kit-restyles.mjs           report what would change
//   node scripts/kit-restyles.mjs --write   apply the change
//   node scripts/kit-restyles.mjs --check   exit 1 while any restyle remains
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const KIT_MODULE = /^@gears-frontx\/ui-kit(\/|$)/;
const SKIP_FILE = /\.test\.|\.stories\.|\/mocks\//;

const CONTROLS = new Set([
  "Avatar",
  "Badge",
  "Button",
  "Checkbox",
  "ComboboxInput",
  "DatePicker",
  "Input",
  "SelectTrigger",
  "SidebarMenuButton",
  "Spinner",
  "Switch",
  "TableCell",
  "TableHead",
  "Textarea",
  "ToggleGroupItem",
]);
// The kit draws nothing on these parts, so every class on them is our own layout.
const UNSTYLED = new Set(["Collapsible", "CollapsibleContent"]);
const UNPADDED = new Set(["TabsContent"]);
const OWN_DISPLAY = /^(flex|inline-flex|grid|inline-grid)$/;
const TEXT_LAYOUT =
  /^text-(left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/;
const TEXT_SIZE = /^text-(xs|sm|base|lg|xl|[2-9]xl|\[\d)/;

const SIZE_PROPS = {
  Spinner: {
    "size-6": ["size", "lg"],
    "size-8": ["size", "lg"],
    "size-10": ["size", "lg"],
    "size-12": ["size", "lg"],
    "size-3": ["compact", true],
  },
  SelectTrigger: { "h-8": ["size", "sm"] },
};

/** Split `hover:md:bg-x` into variants and base, ignoring colons inside brackets. */
export function parseToken(token) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of token) {
    if (ch === "[" || ch === "(") depth++;
    if (ch === "]" || ch === ")") depth--;
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return { variants: parts, base: current.replace(/^!/, "") };
}

/** The restyle category of one class token on a kit component, or null when the token only places it. */
export function restyleCategory(token, tag, siblings) {
  const { variants, base } = parseToken(token);
  if (UNSTYLED.has(tag)) return null;

  const pseudo = variants.find((v) => v === "before" || v === "after");
  if (pseudo) {
    // A one-pixel-wide pseudo element is a vertical grid line the kit does not draw.
    if (siblings.includes(`${pseudo}:w-px`)) return "grid line";
    // A one-pixel-high one redraws the kit's row border, which a sticky cell loses.
    return null;
  }
  if (base.includes("var(--border)")) return null;

  // A sticky cell needs an opaque fill so rows scroll under it, and a fixed height so the next sticky row can offset by it.
  if (
    siblings.includes("sticky") &&
    (/^bg-/.test(base) || /^(h|min-h)-/.test(base))
  )
    return null;

  if (/^-?p[xytblrse]?-/.test(base)) {
    if (UNPADDED.has(tag)) return null;
    return "padding";
  }
  if (TEXT_SIZE.test(base)) return "text size";
  if (
    /^font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.test(
      base
    )
  )
    return "font weight";
  if (
    /^(leading|tracking)-/.test(base) ||
    /^(uppercase|lowercase|capitalize|normal-case)$/.test(base)
  )
    return "type";
  if (/^text-/.test(base) && !TEXT_LAYOUT.test(base)) return "text colour";
  if (/^bg-/.test(base)) return "background";
  // The kit Sidebar draws no edge, so this line is what separates the rail from the page.
  if (tag === "Sidebar" && /^border-[eslr]$/.test(base)) return null;
  if (/^border/.test(base) && !/^border-(collapse|separate|spacing)/.test(base))
    return "border";
  if (/^rounded/.test(base)) return "radius";
  if (/^shadow/.test(base)) return "shadow";
  if (/^ring/.test(base)) {
    // A focusable card shows focus only through this ring.
    if (tag === "Card" && variants.includes("focus-within")) return null;
    return "ring";
  }
  if (/^outline/.test(base)) return "outline";
  // Kit cells have a fixed height, and a cell holding several lines must grow.
  if ((tag === "TableCell" || tag === "TableHead") && base === "h-auto")
    return null;
  if (/^opacity-/.test(base) && variants.some((v) => /disabled/.test(v)))
    return "disabled look";
  if (base === "transition-colors") return "transition";
  if (CONTROLS.has(tag) && /^(h|size|min-h)-/.test(base)) return "control size";
  if (
    /^gap(-[xy])?-/.test(base) &&
    !siblings.some((s) => OWN_DISPLAY.test(parseToken(s).base))
  )
    return "gap";
  return null;
}

function kitTags(source) {
  const tags = new Set();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !KIT_MODULE.test(statement.moduleSpecifier.text)
    )
      continue;
    statement.importClause?.namedBindings?.elements?.forEach((e) =>
      tags.add(e.name.text)
    );
  }
  return tags;
}

function isLiteral(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** Class-position string literals inside a className expression, plus the parts that are not literals. Comparison operands are not class strings. */
function classLiterals(node, out, opaque) {
  if (isLiteral(node)) out.push(node);
  else if (ts.isParenthesizedExpression(node))
    classLiterals(node.expression, out, opaque);
  else if (ts.isConditionalExpression(node)) {
    classLiterals(node.whenTrue, out, opaque);
    classLiterals(node.whenFalse, out, opaque);
  } else if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    classLiterals(node.right, out, opaque);
  } else if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    classLiterals(node.left, out, opaque);
    classLiterals(node.right, out, opaque);
  } else if (ts.isCallExpression(node) && node.expression.getText() === "cn")
    node.arguments.forEach((a) => classLiterals(a, out, opaque));
  else if (ts.isArrayLiteralExpression(node))
    node.elements.forEach((e) => classLiterals(e, out, opaque));
  else if (
    !(
      ts.isIdentifier(node) &&
      (node.text === "className" || node.text === "undefined")
    ) &&
    node.kind !== ts.SyntaxKind.NullKeyword
  )
    opaque.push(node.getText());
  return out;
}

/** True when an argument of cn() holds nothing once its literals are rewritten. */
function emptiesOut(node, rewritten) {
  if (isLiteral(node)) return rewritten.get(node) === "";
  if (ts.isParenthesizedExpression(node))
    return emptiesOut(node.expression, rewritten);
  if (ts.isConditionalExpression(node))
    return (
      emptiesOut(node.whenTrue, rewritten) &&
      emptiesOut(node.whenFalse, rewritten)
    );
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  )
    return emptiesOut(node.right, rewritten);
  return false;
}

function quote(literal, text, source) {
  const q = literal.getText(source)[0];
  return q + text + q;
}

function processFile(file, report) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const tags = kitTags(source);
  if (!tags.size) return null;
  const edits = [];

  const visit = (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      tags.has(node.tagName.getText(source).split(".")[0])
    ) {
      handleElement(node);
    }
    ts.forEachChild(node, visit);
  };

  const handleElement = (element) => {
    const tag = element.tagName.getText(source);
    const attribute = element.attributes.properties.find(
      (p) => ts.isJsxAttribute(p) && p.name.getText(source) === "className"
    );
    if (!attribute?.initializer) return;
    const where = `${path.relative(process.cwd(), file)}:${source.getLineAndCharacterOfPosition(element.getStart()).line + 1}`;
    const expression = ts.isJsxExpression(attribute.initializer)
      ? attribute.initializer.expression
      : attribute.initializer;
    const opaque = [];
    const literals = classLiterals(expression, [], opaque);
    if (opaque.length)
      report.dynamic.push(`${where} <${tag}> ${opaque.join(", ")}`);
    if (!literals.length) return;

    const siblings = literals.flatMap((l) =>
      l.text.split(/\s+/).filter(Boolean)
    );
    const rewritten = new Map();
    const props = [];
    for (const literal of literals) {
      const kept = [];
      for (const token of literal.text.split(/\s+/).filter(Boolean)) {
        const category = restyleCategory(token, tag, siblings);
        if (!category) {
          kept.push(token);
          continue;
        }
        report.removed.push({ where, tag, token, category });
        const prop = SIZE_PROPS[tag]?.[parseToken(token).base];
        if (
          prop &&
          !element.attributes.properties.some(
            (p) => ts.isJsxAttribute(p) && p.name.getText(source) === prop[0]
          )
        )
          props.push(prop);
      }
      if (kept.length !== literal.text.split(/\s+/).filter(Boolean).length)
        rewritten.set(literal, kept.join(" "));
    }
    if (!rewritten.size) return;

    for (const [name, value] of new Map(props)) {
      edits.push({
        start: element.tagName.end,
        end: element.tagName.end,
        text: value === true ? ` ${name}` : ` ${name}="${value}"`,
      });
      report.props.push(
        `${where} <${tag} ${name}${value === true ? "" : `="${value}"`}>`
      );
    }

    const removeAttribute = () =>
      edits.push({
        start: attribute.getFullStart(),
        end: attribute.end,
        text: "",
      });
    if (isLiteral(expression)) {
      if (rewritten.get(expression) === "") removeAttribute();
      else
        edits.push({
          start: expression.getStart(source),
          end: expression.end,
          text: quote(expression, rewritten.get(expression), source),
        });
      return;
    }

    const call =
      ts.isCallExpression(expression) &&
      expression.expression.getText(source) === "cn"
        ? expression
        : null;
    const literalEdits = (node) => {
      for (const [literal, value] of rewritten) {
        if (literal.pos >= node.pos && literal.end <= node.end)
          edits.push({
            start: literal.getStart(source),
            end: literal.end,
            text: quote(literal, value, source),
          });
      }
    };
    if (!call) {
      literalEdits(expression);
      return;
    }

    const args = call.arguments;
    const kept = args.filter((a) => !emptiesOut(a, rewritten));
    if (!kept.length) {
      removeAttribute();
      return;
    }
    if (kept.length === 1 && isLiteral(kept[0])) {
      const only = kept[0];
      const value = rewritten.has(only) ? rewritten.get(only) : only.text;
      edits.push({
        start: attribute.initializer.getStart(source),
        end: attribute.initializer.end,
        text: `"${value}"`,
      });
      return;
    }
    args.forEach((arg, i) => {
      if (kept.includes(arg)) {
        literalEdits(arg);
        return;
      }
      const start = i === 0 ? arg.getStart(source) : args[i - 1].end;
      const end = i === 0 ? args[1].getStart(source) : arg.end;
      edits.push({ start, end, text: "" });
    });
  };

  visit(source);
  if (!edits.length) return null;
  // At a shared start, apply the removal before the insertion, or the insertion lands inside the removed range.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const edit of edits)
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return full.endsWith(".tsx") && !SKIP_FILE.test(full) ? [full] : [];
  });
}

function main() {
  const mode = process.argv[2] ?? "--report";
  const report = { removed: [], props: [], dynamic: [] };
  const changed = [];
  for (const file of sourceFiles(path.resolve("src"))) {
    const next = processFile(file, report);
    if (next === null) continue;
    changed.push(file);
    if (mode === "--write") fs.writeFileSync(file, next);
  }

  const tally = (key) =>
    Object.entries(Object.groupBy(report.removed, (r) => r[key]))
      .map(([k, v]) => `${k} ${v.length}`)
      .join(", ");
  console.log(
    `${report.removed.length} restyle classes in ${changed.length} files`
  );
  console.log(`by category: ${tally("category")}`);
  console.log(`by component: ${tally("tag")}`);
  if (report.props.length)
    console.log(`kit props set:\n  ${report.props.join("\n  ")}`);
  if (report.dynamic.length)
    console.log(`class parts not read:\n  ${report.dynamic.join("\n  ")}`);
  if (mode === "--report")
    report.removed.forEach((r) =>
      console.log(`  ${r.where} <${r.tag}> ${r.token} (${r.category})`)
    );
  if (mode === "--check" && report.removed.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
