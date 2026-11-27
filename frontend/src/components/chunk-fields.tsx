import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

export interface ChunkValues {
  chunk_size: number
  chunk_overlap: number
}

export function chunkError(v: ChunkValues): string | null {
  if (
    !Number.isFinite(v.chunk_size) ||
    v.chunk_size < 200 ||
    v.chunk_size > 8000
  )
    return "Chunk size must be between 200 and 8000 characters."
  if (!Number.isFinite(v.chunk_overlap) || v.chunk_overlap < 0)
    return "Overlap cannot be negative."
  if (v.chunk_overlap >= v.chunk_size / 2)
    return "Overlap must be less than half the chunk size."
  return null
}

export function ChunkFields({
  value,
  onChange,
}: {
  value: ChunkValues
  onChange: (v: ChunkValues) => void
}) {
  const error = chunkError(value)
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor="chunk-size">Chunk size</FieldLabel>
          <Input
            id="chunk-size"
            type="number"
            min={200}
            max={8000}
            step={50}
            value={value.chunk_size}
            onChange={(e) =>
              onChange({ ...value, chunk_size: e.target.valueAsNumber })
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="chunk-overlap">Overlap</FieldLabel>
          <Input
            id="chunk-overlap"
            type="number"
            min={0}
            max={2000}
            step={10}
            value={value.chunk_overlap}
            onChange={(e) =>
              onChange({ ...value, chunk_overlap: e.target.valueAsNumber })
            }
          />
        </Field>
      </div>
      <FieldDescription>
        Characters per indexed passage, and how many characters neighbouring
        passages share. Smaller chunks find precise facts, larger chunks keep
        more context.
      </FieldDescription>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
