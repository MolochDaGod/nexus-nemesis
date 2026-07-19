-- Nexus Nemesis season scheme migration
-- Season 0 = library / legacy no-tribe
-- Season 1 = tribe pack pool (max 100,000)

-- 1) Existing real-tribe inventory becomes Season 1 pack stock
UPDATE nexus_cards
SET season = 'Season 1',
    updated_at = NOW()
WHERE tribe IS NOT NULL
  AND tribe <> 'Library'
  AND tribe <> ''
  AND (season IS NULL OR season = 'Season 0' OR season = 'Season0');

-- 2) Library / empty tribe rows stay Season 0 no-tribe
UPDATE nexus_cards
SET season = 'Season 0',
    tribe = 'Library',
    tribe_bg = COALESCE(NULLIF(tribe_bg, ''), ''),
    tribe_border = COALESCE(NULLIF(tribe_border, ''), ''),
    is_signature = FALSE,
    updated_at = NOW()
WHERE tribe IS NULL
   OR tribe = ''
   OR tribe = 'Library'
   OR season = 'Season 0' AND (tribe IS NULL OR tribe = '' OR tribe = 'Library');

-- 3) Helpful indexes for pack open + supply
CREATE INDEX IF NOT EXISTS idx_nexus_cards_season ON nexus_cards(season);
CREATE INDEX IF NOT EXISTS idx_nexus_cards_unowned_tribe
  ON nexus_cards(tribe)
  WHERE owner_grudge_id IS NULL AND tribe IS NOT NULL AND tribe <> 'Library';
