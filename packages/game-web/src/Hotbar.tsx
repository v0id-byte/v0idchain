// 底部 8 格快捷栏：工具（含耐久条）+ 物品（含数量）。
export interface InventorySlot {
  kind: string;
  label: string;
  icon: string;
  count: number;
  durability?: number;   // 当前耐久（仅工具）
  maxDurability?: number;
  chain?: { type: 'mine_discovery'; depth: number; x: number; y: number; kind: string };
}

interface Props {
  slots: InventorySlot[];
  selected: number;
  onSelect: (i: number) => void;
}

export const SLOT_COUNT = 8;

export default function Hotbar({ slots, selected, onSelect }: Props) {
  return (
    <div className="hotbar">
      {Array.from({ length: SLOT_COUNT }, (_, i) => {
        const s = slots[i];
        return (
          <button
            key={i}
            className={`hotbar-slot${selected === i ? ' selected' : ''}${!s ? ' empty' : ''}`}
            onClick={() => onSelect(i)}
          >
            {s ? (
              <>
                <span className="hotbar-icon">{s.icon}</span>
                {s.durability !== undefined && s.maxDurability !== undefined ? (
                  <div className="hotbar-dur">
                    <div
                      className="hotbar-dur-fill"
                      style={{
                        width: `${Math.max(0, (s.durability / s.maxDurability) * 100)}%`,
                        background: s.durability / s.maxDurability > 0.4 ? '#4caf66' : s.durability / s.maxDurability > 0.15 ? '#e8a030' : '#d94040',
                      }}
                    />
                  </div>
                ) : s.count > 1 ? (
                  <span className="hotbar-count">{s.count}</span>
                ) : null}
              </>
            ) : (
              <span className="hotbar-num">{i + 1}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// 默认起始工具（不烧币，纯本地）
export const DEFAULT_INVENTORY: InventorySlot[] = [
  { kind: 'tool_rod',    label: '鱼竿',   icon: '🎣', count: 1, durability: 30, maxDurability: 30 },
  { kind: 'tool_hoe',   label: '锄头',   icon: '⛏️', count: 1, durability: 20, maxDurability: 20 },
  { kind: 'tool_can',   label: '水桶',   icon: '🪣', count: 1, durability: 15, maxDurability: 15 },
  { kind: 'tool_axe',   label: '斧子',   icon: '🪓', count: 1, durability: 25, maxDurability: 25 },
  { kind: 'tool_pickaxe', label: '矿镐', icon: '⛏️', count: 1, durability: 45, maxDurability: 45 },
  { kind: 'tool_sword', label: '短剑', icon: '🗡️', count: 1, durability: 35, maxDurability: 35 },
];
