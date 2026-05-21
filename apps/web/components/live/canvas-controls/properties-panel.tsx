"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { Close, Renew } from "@carbon/icons-react"
import { Popover as PopoverPrimitive } from "radix-ui"
import { BoxIcon } from "./box-icon"
import { PropertiesTrigger } from "./properties-trigger"
import { useCanvasControls } from "./canvas-controls-context"
import {
  COLOR_ACTIVE_BG,
  COLOR_ACTIVE_FG,
  COLOR_INACTIVE_BG,
  COLOR_INACTIVE_FG,
  COLOR_MUTED,
  FORM_CHIP_FONT,
  FORM_CHIP_GAP,
  FORM_CHIP_HEIGHT,
  FORM_CHIP_PAD_X,
  FORM_CHIP_RADIUS,
  PANEL_DIVIDER_COLOR,
  PANEL_RADIUS,
  PANEL_ROW_TEXT_SIZE,
  PANEL_SECTION_LABEL_SIZE,
  PANEL_SECTION_LABEL_WEIGHT,
  PANEL_VAROPTS_HEIGHT,
  PANEL_VAROPTS_WIDTH,
  PANEL_WIDTH,
  SCROLL_FADE_WIDTH,
  SIZE_CHIP_H,
  SIZE_CHIP_W,
  SWITCH_H,
  SWITCH_KNOB,
  SWITCH_OFF_BG,
  SWITCH_ON_BG,
  SWITCH_PAD,
  SWITCH_RADIUS,
  SWITCH_W,
} from "./canvas-controls.config"

// Tracks the panel surface so the inline scroll fades match whatever color
// the panel is painted with — including the dark-mode bump to bg-elevated.
const PANEL_FADE_BG = "var(--color-bg-elevated)"

const panelStyle: CSSProperties = {
  width: PANEL_WIDTH,
  borderRadius: PANEL_RADIUS,
  background: "var(--color-bg-elevated)",
  border: "1px solid var(--color-border-primary)",
  boxShadow: "var(--shadow-medium)",
  padding: 0,
  outline: "none",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
}

const headerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "16px 20px 12px 20px",
}

const dividerStyle: CSSProperties = {
  height: 1,
  background: PANEL_DIVIDER_COLOR,
  width: "100%",
  flexShrink: 0,
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 20px",
  gap: 12,
}

const rowLabelStyle: CSSProperties = {
  color: COLOR_INACTIVE_FG,
  fontSize: PANEL_ROW_TEXT_SIZE,
  fontWeight: 400,
  lineHeight: 1,
}

const sectionStyle: CSSProperties = {
  padding: "12px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
}

const sectionTitleStyle: CSSProperties = {
  color: COLOR_MUTED,
  fontSize: PANEL_SECTION_LABEL_SIZE,
  fontWeight: PANEL_SECTION_LABEL_WEIGHT,
  letterSpacing: "0.5px",
  textTransform: "uppercase",
  lineHeight: 1,
  userSelect: "none",
}

const closeButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: COLOR_MUTED,
  width: 20,
  height: 20,
  cursor: "pointer",
  borderRadius: "var(--radius-1-5)",
}

const varOptsWrapStyle: CSSProperties = {
  position: "relative",
  width: PANEL_VAROPTS_WIDTH,
  height: PANEL_VAROPTS_HEIGHT,
  flexShrink: 0,
}

const varOptsScrollStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  overflowX: "auto",
  overflowY: "hidden",
  overscrollBehaviorX: "contain",
  display: "flex",
  alignItems: "center",
}

const varOptsRowStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 16,
  // Anchor right so the selected tab is visible when the row overflows.
  marginLeft: "auto",
}

const varOptsFadeBase: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  width: SCROLL_FADE_WIDTH,
  pointerEvents: "none",
  transition: "opacity var(--duration-micro) var(--ease-swift)",
}

function VariantTabs({
  options,
  value,
  onChange,
}: {
  options: string[]
  value: string
  onChange: (next: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(true)

  const recalc = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setAtStart(el.scrollLeft <= 0)
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    recalc()
    const ro = new ResizeObserver(recalc)
    ro.observe(el)
    return () => ro.disconnect()
  }, [recalc])

  return (
    <div style={varOptsWrapStyle}>
      <div
        ref={scrollRef}
        onScroll={recalc}
        className="scrollbar-hidden"
        style={varOptsScrollStyle}
      >
        <div style={varOptsRowStyle}>
          {options.map((opt) => {
            const active = opt === value
            return (
              <button
                key={opt}
                type="button"
                onClick={() => onChange(opt)}
                style={{
                  flexShrink: 0,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 4,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <span
                  style={{
                    fontSize: PANEL_ROW_TEXT_SIZE,
                    fontWeight: active ? 500 : 400,
                    color: active ? "var(--color-text-primary)" : COLOR_MUTED,
                    lineHeight: 1,
                    textTransform: "capitalize",
                    whiteSpace: "nowrap",
                  }}
                >
                  {opt}
                </span>
                <span
                  style={{
                    height: 2,
                    width: "100%",
                    background: active
                      ? "var(--color-text-primary)"
                      : "transparent",
                    borderRadius: 1,
                  }}
                />
              </button>
            )
          })}
        </div>
      </div>
      <div
        aria-hidden
        style={{
          ...varOptsFadeBase,
          left: 0,
          background: `linear-gradient(to right, ${PANEL_FADE_BG}, transparent)`,
          opacity: atStart ? 0 : 1,
        }}
      />
      <div
        aria-hidden
        style={{
          ...varOptsFadeBase,
          right: 0,
          background: `linear-gradient(to left, ${PANEL_FADE_BG}, transparent)`,
          opacity: atEnd ? 0 : 1,
        }}
      />
    </div>
  )
}

function SizePills({
  options,
  value,
  onChange,
}: {
  options: string[]
  value: string
  onChange: (next: string) => void
}) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {options.map((opt) => {
        const active = opt === value
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            style={{
              width: SIZE_CHIP_W,
              height: SIZE_CHIP_H,
              borderRadius: 6,
              background: active ? COLOR_ACTIVE_BG : COLOR_INACTIVE_BG,
              color: active ? COLOR_ACTIVE_FG : COLOR_INACTIVE_FG,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              padding: 0,
            }}
            aria-label={`Size ${opt}`}
            aria-pressed={active}
          >
            <BoxIcon
              size={opt}
              color={active ? COLOR_ACTIVE_FG : COLOR_INACTIVE_FG}
            />
          </button>
        )
      })}
    </div>
  )
}

function FormChipGrid({
  options,
  value,
  onChange,
}: {
  options: string[]
  value: string
  onChange: (next: string) => void
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: FORM_CHIP_GAP,
      }}
    >
      {options.map((opt) => {
        const active = opt === value
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            style={{
              height: FORM_CHIP_HEIGHT,
              padding: `0 ${FORM_CHIP_PAD_X}px`,
              borderRadius: FORM_CHIP_RADIUS,
              background: active ? COLOR_ACTIVE_BG : COLOR_INACTIVE_BG,
              color: active ? COLOR_ACTIVE_FG : COLOR_INACTIVE_FG,
              fontSize: FORM_CHIP_FONT,
              fontWeight: 400,
              lineHeight: 1,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              textTransform: "capitalize",
              whiteSpace: "nowrap",
            }}
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      style={{
        width: SWITCH_W,
        height: SWITCH_H,
        borderRadius: SWITCH_RADIUS,
        background: checked ? SWITCH_ON_BG : SWITCH_OFF_BG,
        padding: SWITCH_PAD,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: checked ? "flex-end" : "flex-start",
        cursor: "pointer",
        transition: "background-color var(--duration-fast) var(--ease-out-soft)",
      }}
    >
      <span
        style={{
          width: SWITCH_KNOB,
          height: SWITCH_KNOB,
          borderRadius: SWITCH_KNOB / 2,
          background: "var(--color-bg-primary)",
          boxShadow: "var(--shadow-small)",
        }}
      />
    </button>
  )
}

// Carbon Icons has no diamond; custom SVG.
function DiamondIcon({ color = "currentColor" }: { color?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M6 1 L11 6 L6 11 L1 6 Z" fill={color} />
    </svg>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={sectionStyle}>
      <span style={sectionTitleStyle}>{title}</span>
      {children}
    </div>
  )
}

const inputStyle: CSSProperties = {
  height: 28,
  minWidth: 140,
  maxWidth: 180,
  padding: "0 8px",
  borderRadius: 6,
  background: COLOR_INACTIVE_BG,
  border: "1px solid var(--color-border-secondary)",
  color: "var(--color-text-primary)",
  fontSize: PANEL_ROW_TEXT_SIZE,
  lineHeight: 1,
  outline: "none",
  fontFamily: "inherit",
}

const typeBadgeStyle: CSSProperties = {
  maxWidth: 200,
  padding: "4px 8px",
  borderRadius: 6,
  background: COLOR_INACTIVE_BG,
  color: COLOR_INACTIVE_FG,
  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  fontSize: 11,
  lineHeight: 1.2,
  textAlign: "right",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
}

function labelOf(prop: string): string {
  return prop.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())
}

function toNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

function PropRow({ prop, children }: { prop: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 36,
        gap: 12,
      }}
    >
      <span style={{ ...rowLabelStyle, textTransform: "capitalize" }}>
        {labelOf(prop)}
      </span>
      {children}
    </div>
  )
}

function TextInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: string
  onChange: (next: string) => void
  ariaLabel: string
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      style={inputStyle}
    />
  )
}

function NumberInput({
  value,
  onChange,
  ariaLabel,
}: {
  value: number
  onChange: (next: number) => void
  ariaLabel: string
}) {
  return (
    <input
      type="number"
      value={value}
      onChange={(e) => onChange(toNumber(e.target.value))}
      aria-label={ariaLabel}
      style={inputStyle}
    />
  )
}

function TypeBadge({ text }: { text: string }) {
  return (
    <span style={typeBadgeStyle} title={text}>
      {text}
    </span>
  )
}

export function PropertiesPanel() {
  const { manifest, props, setProp, applyPreset, reset } = useCanvasControls()
  const [open, setOpen] = useState(false)

  if (!manifest) return null

  const { controls } = manifest
  const stateLines = Object.entries(props).map(
    ([key, val]) => `${key}: ${JSON.stringify(val)}`,
  )
  // Step 5.5 — named presets from a `<Component>.usemount.tsx` override file
  // (manifest.states). Each value is a props object applied as a clean scenario.
  const presetEntries = Object.entries(manifest.states).filter(
    (e): e is [string, Record<string, unknown>] =>
      !!e[1] && typeof e[1] === "object" && !Array.isArray(e[1]),
  )

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
        <PopoverPrimitive.Trigger asChild>
          <PropertiesTrigger open={open} />
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            side="bottom"
            align="end"
            sideOffset={12}
            style={{
              ...panelStyle,
              transformOrigin: "var(--radix-popover-content-transform-origin)",
            }}
          >
            <div style={headerStyle}>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--color-text-primary)",
                  lineHeight: 1,
                }}
              >
                Properties
              </span>
              <button
                type="button"
                aria-label="Close properties"
                onClick={() => setOpen(false)}
                style={closeButtonStyle}
              >
                <Close size={16} />
              </button>
            </div>
            <div style={dividerStyle} />

            {presetEntries.length > 0 && (
              <>
                <Section title="Presets">
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: FORM_CHIP_GAP,
                    }}
                  >
                    {presetEntries.map(([name, values]) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => applyPreset(values)}
                        style={{
                          height: FORM_CHIP_HEIGHT,
                          padding: `0 ${FORM_CHIP_PAD_X}px`,
                          borderRadius: FORM_CHIP_RADIUS,
                          background: COLOR_INACTIVE_BG,
                          color: COLOR_INACTIVE_FG,
                          fontSize: FORM_CHIP_FONT,
                          border: "none",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </Section>
                <div style={dividerStyle} />
              </>
            )}

            {(controls.variants || controls.sizes) && (
              <>
                <div
                  style={{
                    padding: "4px 0",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  {controls.variants && (
                    <div style={rowStyle}>
                      <span style={rowLabelStyle}>Variant</span>
                      <VariantTabs
                        options={controls.variants.options}
                        value={String(props[controls.variants.prop])}
                        onChange={(next) =>
                          setProp(controls.variants!.prop, next)
                        }
                      />
                    </div>
                  )}
                  {controls.sizes && (
                    <div style={rowStyle}>
                      <span style={rowLabelStyle}>Size</span>
                      <SizePills
                        options={controls.sizes.options}
                        value={String(props[controls.sizes.prop])}
                        onChange={(next) => setProp(controls.sizes!.prop, next)}
                      />
                    </div>
                  )}
                </div>
                <div style={dividerStyle} />
              </>
            )}

            {controls.forms && (
              <>
                <Section title="Form">
                  <FormChipGrid
                    options={controls.forms.options}
                    value={String(props[controls.forms.prop])}
                    onChange={(next) => setProp(controls.forms!.prop, next)}
                  />
                </Section>
                <div style={dividerStyle} />
              </>
            )}

            {controls.booleans.length > 0 && (
              <>
                <Section title="Options">
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    {controls.booleans.map((key) => {
                      const active = !!props[key]
                      const label = key
                        .replace(/([A-Z])/g, " $1")
                        .replace(/^./, (c) => c.toUpperCase())
                      return (
                        <div
                          key={key}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            height: 36,
                          }}
                        >
                          <span
                            style={{
                              ...rowLabelStyle,
                              textTransform: "capitalize",
                            }}
                          >
                            {label}
                          </span>
                          <Switch
                            checked={active}
                            onChange={(next) => setProp(key, next)}
                            label={label}
                          />
                        </div>
                      )
                    })}
                  </div>
                </Section>
                <div style={dividerStyle} />
              </>
            )}

            {controls.slots.length > 0 && (
              <>
                <Section title="Slots">
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    {controls.slots.map((slot) => (
                      <div
                        key={slot.prop}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          height: 36,
                        }}
                      >
                        <span style={rowLabelStyle}>{slot.label}</span>
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            color: COLOR_MUTED,
                            fontSize: 12,
                            lineHeight: 1,
                          }}
                        >
                          <DiamondIcon color={COLOR_MUTED} />
                          {props[slot.prop] ? "Set" : "Default"}
                        </span>
                      </div>
                    ))}
                  </div>
                </Section>
                <div style={dividerStyle} />
              </>
            )}

            {controls.strings.length > 0 && (
              <>
                <Section title="Text">
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {controls.strings.map(({ prop }) => (
                      <PropRow key={prop} prop={prop}>
                        <TextInput
                          value={String(props[prop] ?? "")}
                          onChange={(next) => setProp(prop, next)}
                          ariaLabel={labelOf(prop)}
                        />
                      </PropRow>
                    ))}
                  </div>
                </Section>
                <div style={dividerStyle} />
              </>
            )}

            {controls.numbers.length > 0 && (
              <>
                <Section title="Numbers">
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {controls.numbers.map(({ prop }) => (
                      <PropRow key={prop} prop={prop}>
                        <NumberInput
                          value={toNumber(props[prop])}
                          onChange={(next) => setProp(prop, next)}
                          ariaLabel={labelOf(prop)}
                        />
                      </PropRow>
                    ))}
                  </div>
                </Section>
                <div style={dividerStyle} />
              </>
            )}

            {controls.handlers.length > 0 && (
              <>
                <Section title="Callbacks">
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {controls.handlers.map(({ prop, signature }) => (
                      <PropRow key={prop} prop={prop}>
                        <TypeBadge text={signature} />
                      </PropRow>
                    ))}
                  </div>
                </Section>
                <div style={dividerStyle} />
              </>
            )}

            {controls.objects.length > 0 && (
              <>
                <Section title="Objects">
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    {controls.objects.map(({ prop, typeString }) => (
                      <PropRow key={prop} prop={prop}>
                        <TypeBadge text={typeString} />
                      </PropRow>
                    ))}
                  </div>
                </Section>
                <div style={dividerStyle} />
              </>
            )}

            <Section title="State">
              <div
                style={{
                  background: "var(--color-bg-hover-elevated)",
                  borderRadius: 8,
                  padding: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 5,
                }}
              >
                {stateLines.map((line) => (
                  <span
                    key={line}
                    style={{
                      fontFamily:
                        'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
                      fontSize: 11,
                      fontWeight: 400,
                      color: COLOR_INACTIVE_FG,
                      lineHeight: 1,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {line}
                  </span>
                ))}
              </div>
            </Section>
            <div style={dividerStyle} />

            <button
              type="button"
              onClick={reset}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "12px 20px",
                color: COLOR_MUTED,
                fontSize: 12,
                fontWeight: 400,
                lineHeight: 1,
                cursor: "pointer",
                width: "100%",
              }}
            >
              <Renew size={13} />
              Reset to Default
            </button>
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
  )
}
