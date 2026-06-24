// 移动端热键栏：显示当前道具栏（工具/材料/作物）
export interface InventorySlot {
  kind: string;
  label: string;
  icon: string;
  count: number;
  durability?: number;
  maxDurability?: number;
  chain?: { type: 'mine_discovery'; kind: string; depth: number; x: number; y: number };
}

export const DEFAULT_INVENTORY: InventorySlot[] = [];

interface HotbarProps {
  slots: InventorySlot[];
  selected: number;
  onSelect: (i: number) => void;
}

const SLOT_SIZE = 48;
const MAX_SLOTS = 6;

export default function Hotbar({ slots, selected, onSelect }: HotbarProps) {
  const visible = slots.slice(0, MAX_SLOTS);
  return (
    <div style={{
      position: 'fixed',
      bottom: 80,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      gap: 4,
      zIndex: 100,
      pointerEvents: 'none',
    }}>
      {visible.map((slot, i) => (
        <div
          key={i}
          onClick={() => { onSelect(i); }}
          style={{
            width: SLOT_SIZE,
            height: SLOT_SIZE,
            background: i === selected ? '#3a3060' : '#1e1a2e',
            border: `2px solid ${i === selected ? '#8a6af0' : '#3a3060'}`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            pointerEvents: 'auto',
            fontFamily: 'monospace',
            position: 'relative',
          }}
        >
          <span style={{ fontSize: 22 }}>{slot.icon}</span>
          {slot.count > 1 && (
            <span style={{
              position: 'absolute',
              bottom: 2,
              right: 4,
              fontSize: 10,
              color: '#d4aa60',
            }}>
              {slot.count}
            </span>
          )}
        </div>
      ))}
      {/* 空槽位 */}
      {Array.from({ length: Math.max(0, MAX_SLOTS - visible.length) }).map((_, i) => (
        <div
          key={`empty-${i}`}
          style={{
            width: SLOT_SIZE,
            height: SLOT_SIZE,
            background: '#141020',
            border: '2px solid #2a2540',
          }}
        />
      ))}
    </div>
  );
}
