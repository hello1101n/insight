import { Fragment, useId, type ReactElement } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@gears-frontx/ui-kit";
import type { ScheduleTooltipContent } from "@/lib/portal/connector-schedule-tooltip";

type TooltipBody =
  | { content: ScheduleTooltipContent; lines?: never }
  | { lines: string[]; content?: never };

export function ConnectorScheduleTooltip({
  children,
  content,
  lines,
  label,
}: TooltipBody & {
  children: ReactElement;
  label?: string;
}) {
  const id = useId();
  return (
    <Tooltip>
      <TooltipTrigger
        aria-describedby={id}
        render={
          <span
            tabIndex={0}
            role={label ? "img" : undefined}
            aria-label={label}
            className="inline-flex max-w-full min-w-0 cursor-help"
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        id={id}
        role="tooltip"
        className={
          content ? "w-max max-w-[min(36rem,calc(100vw-1.5rem))]" : undefined
        }
      >
        {content ? (
          <div className="min-w-0 space-y-1.5">
            {content.status && <p className="font-normal">{content.status}</p>}
            {content.rows.length > 0 && (
              <ul
                role="list"
                className="grid grid-cols-[fit-content(48%)_minmax(0,1fr)] gap-x-3 gap-y-1 sm:grid-cols-[fit-content(20rem)_minmax(0,1fr)]"
              >
                {content.rows.map((row) => (
                  <li
                    key={row.kind}
                    className="col-span-2 grid grid-cols-subgrid items-baseline"
                  >
                    <span className="wrap-anywhere">
                      <strong className="font-semibold">{row.label}</strong>
                      {" · "}
                      <span className="font-normal opacity-85">
                        {row.qualifier}
                      </span>
                    </span>{" "}
                    <span className="wrap-anywhere">
                      <code className="font-mono">{row.crons.join("; ")}</code>{" "}
                      <span className="ms-1 font-normal">
                        {row.zone.split(/(?<=\/)/).map((part, index) => (
                          <Fragment key={index}>
                            {index > 0 && <wbr />}
                            {part}
                          </Fragment>
                        ))}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-col">
            {lines.map((line, index) => (
              <span key={index} className="block">
                {line}
              </span>
            ))}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
