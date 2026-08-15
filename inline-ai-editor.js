/**
 * SillyTavern Inline AI Editor
 * TavernHelper / JS-Slash-Runner global script.
 *
 * Requirements:
 * - SillyTavern 1.18.0+
 * - TavernHelper (formerly JS-Slash-Runner)
 * - SillyTavern Connection Manager enabled
 */
/**
 * 檔案地圖 — grep 「══════」可以逐一跳到下列區塊。
 *
 *   ══════ 常數與輸出協定 ══════
 *   ══════ 純函式：設定與客製指令 ══════
 *   ══════ 純函式：API 端點與回應 ══════
 *   ══════ 純函式：解析模型輸出 ══════
 *   ══════ 純函式：差異比對與逐行取捨 ══════
 *   ══════ 純函式：參考樓層範圍 ══════
 *   ══════ 純函式：正則規則 ══════
 *   ══════ 純函式：世界書條目 ══════
 *   ══════ 純函式：組裝提示詞 ══════
 *   ══════ 純函式：更新檢查 ══════
 *   ══════ 測試出口（之前不得有 await） ══════
 *   ══════ 宿主繫結、狀態與共用小工具 ══════
 *   ══════ 樣式表 ══════
 *   ══════ 宿主 API 包裝：樓層、正則、世界書 ══════
 *   ══════ 編輯器介面：魔杖、視窗、參考資料 ══════
 *   ══════ 編輯器行為：開啟、儲存、關閉 ══════
 *   ══════ API 請求：直連與代發 ══════
 *   ══════ 差異視窗與審核流程 ══════
 *   ══════ 更新：檢查與寫回腳本庫 ══════
 *   ══════ 表單與設定視窗 ══════
 *   ══════ 生命週期：事件、清理、啟動 ══════
 *
 * 上半部（到「測試出口」為止）是純函式，可以在 Node 裡直接載入測試；
 * 之後才會解析 hostWindow / tavern，而且那之前不能出現任何 await。
 * 細節與各種「改了不會報錯」的地雷見 CLAUDE.md。
 */
(async function bootstrapInlineAiEditor(globalScope) {
    'use strict';

    // ══════ 常數與輸出協定 ══════

    const VERSION = '0.9.1';
    const SETTINGS_KEY = 'st_inline_ai_editor';
    const INSTANCE_KEY = '__ST_INLINE_AI_EDITOR_INSTANCE__';
    const STYLE_ID = 'stiae-styles';
    const ROOT_CLASS = 'stiae-root';

    const DEFAULT_GLOBAL_PROMPT = 'Preserve the source\'s Markdown structure, character voice, narrative POV, and established facts.';

    // The heading ships inside the card's own text rather than being welded on at
    // assembly time. That is what lets the default arrangement produce byte-for-byte
    // what 0.8.0 produced while still leaving the line as something the user can delete.
    const DEFAULT_PRINCIPLES_CARD = `Editing principles:\n${DEFAULT_GLOBAL_PROMPT}`;

    // Three slots whose text is produced at send time. The user can drag them and, for
    // 參考資料, watch them fall away when there is nothing to put in them — but the words
    // are not theirs to edit, and neither is the position of the two pinned ones.
    const SYSTEM_CARD_SLOTS = {
        instruction: { name: '指示', help: '你按下的那個指令，要 AI 做什麼。' },
        reference: { name: '參考資料', help: '你在編輯器裡勾的參考樓層與世界書。一條都沒勾時整段不送出。' },
        target: { name: '目標內文', help: '要編修的那一段文字。有帶參考資料時，結尾會自動再講一次你的指令，免得被前面一大段蓋過去。' },
    };

    // ⚠️ Both pinned cards exist because this tool's output travels back to be matched
    // against the original text character for character and then written into the chat
    // (ADR-0006). 協定 first: the parser's contract. 目標內文 last: it is the single
    // ordering rule that makes "reference material after the prose being edited" — the
    // one arrangement that reliably goes wrong — impossible to express.
    const PINNED_FIRST = 'protocol';
    const PINNED_LAST = 'target';

    // Half-width, unlike the wrapper marks in MARK. A tag the user writes is read by the
    // model as structure, and half-width is the form it has seen countless times. The
    // full-width wrappers guard against a chat message containing the same spelling;
    // that risk barely exists in a card the user typed themselves.
    //
    // ⚠️ search / replace are refused. The model has to emit those two itself and the
    // parser rests entirely on them, so a user-made block boundary of the same name
    // would hand the parser to luck.
    const RESERVED_TAGS = ['search', 'replace', 'replacement'];

    // ⚠️ One spelling, used by the checkbox AND by the error message that tells people to
    // tick it. Written out twice, a rename leaves the error pointing at a switch that no
    // longer exists by that name — and that sentence is the only way anyone finds the
    // switch at all. core.test.cjs asserts the message contains this constant.
    const BACKEND_SWITCH_LABEL = '改由酒館的伺服器幫忙送出';

    // ⚠️ Keys the extra-parameters box may not set. The first three would break the
    // request outright — `messages` and `model` are the whole contract, and `stream`
    // decides which parsing path the code takes, so overriding it desyncs the reader from
    // the reply. `temperature` and `max_tokens` are blocked for a different reason: they
    // have their own fields two rows up, and one setting reachable from two places is a
    // setting nobody can predict.
    const EXTRA_BODY_RESERVED = ['model', 'messages', 'stream', 'temperature', 'max_tokens'];

    // Typing aids, not knowledge. The tool never inspects what is in the box at send
    // time — these only fill the textarea, so a provider changing its parameter is a
    // stale example rather than a branch that silently stops working (產品決策 5).
    const EXTRA_BODY_PRESETS = [
        ['OpenRouter：關閉推理', { reasoning: { effort: 'none' } }],
        ['DeepSeek：關閉推理', { thinking: { type: 'disabled' } }],
    ];

    const MESSAGE_ROLE_LABELS = {
        system: '系統訊息（system）',
        user: '使用者訊息（user）',
        assistant: 'AI 訊息（assistant）',
    };

    // ⚠️ Must stay ABOVE readChangelogFromSource, and the reader's capture must start
    // with a digit — exactly the lesson readVersionFromSource records. The reader's own
    // regex literal contains the text `const CHANGELOG = ` and would otherwise match
    // itself, handing back its own spelling as the newest release notes.
    //
    // Only the last ten releases live here. This string ships inside every copy of the
    // script and an unbounded one would grow the file forever.
    const CHANGELOG = `0.9.1
- API 設定多了「額外參數」欄位：填一段 JSON，會原樣加進送出的請求裡。
- 最常見的用途是關掉推理模型的思考（DeepSeek 之類的思考又長又貴）。各家參數名稱不一樣，所以不做成勾選框；附了 OpenRouter 與 DeepSeek 兩顆一鍵填入。
- 直連與「改由酒館的伺服器幫忙送出」兩條路都有效，接法不同但你不用管。
- model、messages、stream、temperature、max_tokens 這幾個不准在這裡設，填了會明講被忽略。

0.9.0
- 模型連線改用工具自己的「API 設定」，不再借用 SillyTavern 的 Connection Profile。可以存好幾組，指令能各自指定要用哪一組。
- 升級後要重新填一次端點與金鑰：金鑰存在酒館伺服器裡，這裡讀不到，搬不過來。
- 編修請求不再被主聊天的 preset 罩住。送出去的東西現在完全由這個工具決定。
- 端點撞到跨域限制時，可以改由酒館伺服器代發。錯誤訊息會直接告訴你去勾哪裡。
- 提示詞改成一份模組清單，看得到協定、指示、參考資料、內文各自排在哪裡，也可以插入自己的模組。
- 設定視窗拆成四個分頁：API 設定、指令設定、提示詞設定、版本日誌與設定備份。
- 「複製設定代碼」不再包含 API 金鑰。

0.8.0
- 這次要帶什麼給 AI，全部搬到編輯器右邊的側邊欄，不再擠佔正文。
- 勾了哪幾條世界書一眼看得到，可以逐條檢視或取消。
- 點參考樓層可以直接看那一樓的完整內文，正則改動過的還能對照原始內容。
- 正則勾選搬到側邊欄，勾了立刻生效。
- 側邊欄最下面多了「預覽這次的請求」。

0.7.2
- 修正內建指令那四列的排版跑掉（只在 0.7.1 出現過）。

0.7.1
- 修好「更多」選單被工具列裁掉，實測只露出 4px。
- 分組變成工具列上的資料夾按鈕，指令可以拖曳排序、拖到別組。
- 「複製設定／貼上設定」改名為「複製設定代碼／匯入設定代碼」。

0.7.0
- 選世界書條目改成獨立視窗，搜尋框與書本選單不會被捲走。
- 客製指令可以分組，也可以只複製指令代碼分享出去。
- 新增「檢查更新」與「更新腳本」，按下去才連外網。

0.6.1
- 魔杖從 ⋯ 選單拉到樓層動作列上，少按一次。
- 修正窄螢幕上「查看整個樓層的修改位置」排版錯亂。

0.6.0
- 差異視窗每一個有變更的行都能個別勾選要不要採用，預設全勾。
- 局部修補與全文改寫都適用。

0.5.1
- 臨時指令在同一個編輯器裡會記住剛剛打的字。

0.5.0
- 世界書條目可以勾選當參考資料，勾選會記住。
- 參考樓層只在同一個聊天裡記住，換聊天自動清空。
`;

    // ⚠️ Hard-wired, and it stays hard-wired. A configurable update source is a text box
    // whose value is "run this in my browser" — the whole safety of this feature rests on
    // the address being one the user cannot be talked into changing.
    //
    // The residual risk that cannot be engineered away: whoever controls that repository
    // can ship code into anyone who presses 更新. There is no signature to check, because
    // checking one would need a server this project does not have. Said plainly in
    // README so the choice is the user's.
    // ⚠️ This is the PUBLIC dist repo, not the development one. The development repo is
    // private, and raw.githubusercontent serves 404 for a private repository to everyone
    // — including the owner's own browser, which has no GitHub session to offer. Pointing
    // this at the private repo makes every check fail with 404 and no update ever works.
    // Releases get there via `node tools/publish-dist.cjs <資料夾>`.
    const UPDATE_SOURCE_URL = 'https://raw.githubusercontent.com/lceo72/st-inline-ai-editor-dist/main/inline-ai-editor.js';
    const UPDATE_HOME_URL = 'https://github.com/lceo72/st-inline-ai-editor-dist';
    // The script has never been anywhere near this small. A truncated response, a captive
    // portal's login page or an error page dressed as 200 all land far below it.
    const UPDATE_MIN_LENGTH = 60000;

    const ICONS = [
        ['fa-wand-magic-sparkles', '魔杖'],
        ['fa-pen', '筆'],
        ['fa-spell-check', '校對'],
        ['fa-scissors', '縮短'],
        ['fa-up-right-and-down-left-from-center', '擴寫'],
        ['fa-feather', '文風'],
        ['fa-language', '語言'],
        ['fa-list-check', '檢查'],
        ['fa-comment-dots', '對話'],
        ['fa-book-open', '敘事'],
    ];

    const BUILTIN_ACTIONS = [
        {
            id: 'rewrite',
            name: '重寫',
            icon: 'fa-pen',
            mode: 'replacement',
            instruction: 'Rewrite the scope. Keep the meaning, the character voice, the narrative POV, and roughly the same length; improve the phrasing and the readability.',
        },
        {
            id: 'shorten',
            name: '縮短',
            icon: 'fa-scissors',
            mode: 'replacement',
            instruction: 'Shorten the scope. Cut repetition and padding; keep the information, the voice, and every plot fact.',
        },
        {
            id: 'expand',
            name: '擴寫',
            icon: 'fa-up-right-and-down-left-from-center',
            mode: 'replacement',
            instruction: 'Expand the scope with sensory detail, action, or beats. Every addition follows from what the passage already establishes, and every character keeps the intent they already had.',
        },
        {
            id: 'polish',
            name: '潤飾',
            icon: 'fa-spell-check',
            mode: 'patch',
            instruction: 'Correct grammar, punctuation, word choice, and flow. Change only what is wrong and leave sound passages as they stand.',
        },
    ];

    const LOCKED_PROTOCOL = {
        patch: [
            'Return only search-and-replace pairs, in this exact form:',
            '<search>text taken from the editable scope</search><replace>replacement text</replace>',
            'Copy the search text character for character, including whitespace and punctuation exactly as it appears; do not normalize or convert anything. Carry enough surrounding text to single out one occurrence.',
            'Quotation marks often open and close far apart, so a search may carry only one half of a pair. Copy the halves the scope actually has at that spot. A search that does not appear verbatim is dropped.',
            'Return an empty <replace></replace> to delete the searched text.',
            'Emit one pair per independent change, and no pairs at all when the scope already reads well. Every search comes from the editable scope.',
        ].join('\n'),
        replacement: [
            'Return only the rewritten scope, in this exact form:',
            '<replacement>the complete replacement text</replacement>',
            'The replacement stands in for the entire editable scope, and for nothing outside it.',
        ].join('\n'),
    };

    // Block markers use full-width brackets so a message that happens to contain the
    // half-width spelling cannot be mistaken for a real boundary. This is deliberately
    // the opposite of rewriting the user's own text: the editable scope travels back
    // here to be matched character for character and then written into the chat, so
    // altering it would make every patch miss, or write full-width brackets into the
    // user's prose. We change our markers; we never change their words.
    //
    // <search> / <replace> stay half-width on purpose. The model has to emit those
    // itself, and the half-width spelling is the form it has seen countless times.
    // The parser's correctness rests entirely on them.
    const MARK = {
        referenceOpen: '＜＜＜REFERENCE_MATERIAL＞＞＞',
        referenceClose: '＜＜＜END_REFERENCE_MATERIAL＞＞＞',
        targetOpen: '＜＜＜TARGET_MESSAGE_FULL＞＞＞',
        targetClose: '＜＜＜END_TARGET_MESSAGE_FULL＞＞＞',
        scopeOpen: '＜＜＜EDITABLE_SCOPE＞＞＞',
        scopeClose: '＜＜＜END_EDITABLE_SCOPE＞＞＞',
        fullScopeOpen: '＜＜＜EDITABLE_SCOPE_IS_FULL_MESSAGE＞＞＞',
        fullScopeClose: '＜＜＜END_EDITABLE_SCOPE_IS_FULL_MESSAGE＞＞＞',
    };

    // How the reference material introduces itself. Deliberately "background, for
    // understanding only" rather than "earlier prose of this same story".
    //
    // ⚠️ Known side effect, chosen with the tradeoff understood: the model is less
    // likely to carry over the tone of the referenced passages. If a flashback comes
    // back reading like it belongs to a different book, this constant is the first
    // knob to turn — try wording it as the story's own earlier prose.
    const REFERENCE_IDENTITY = [
        'The excerpts below are background information, provided only so that you can',
        'understand the story. They are read-only: never edit them, never reproduce them,',
        'and never take search text from them.',
    ].join('\n');

    // Said twice on purpose — once here in the protocol and once beside the data. The
    // model taking its search text out of the reference material is a mistake other
    // projects only documented after being bitten by it, and a repeated sentence is
    // far cheaper than a screen full of patches that match nothing.
    const PATCH_REFERENCE_RULE = 'Reference material is not part of the editable scope. Every search must come from the editable scope alone.';

    // ══════ 純函式：設定與客製指令 ══════

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function makeId(prefix = 'cmd') {
        const random = globalScope.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        return `${prefix}-${random}`;
    }

    function normalizeCommand(command, index) {
        return {
            id: String(command?.id || makeId()),
            name: String(command?.name || `指令 ${index + 1}`),
            // Empty means ungrouped, which is what every command from before 0.7.0 is.
            // Only custom commands carry this — builtins keep their own identity and are
            // never mixed into the custom list (ADR-0001).
            group: String(command?.group || '').trim(),
            icon: ICONS.some(([value]) => value === command?.icon) ? command.icon : ICONS[0][0],
            instruction: String(command?.instruction || ''),
            mode: command?.mode === 'replacement' ? 'replacement' : 'patch',
            // Which API 設定 this command uses. Empty means the default one.
            //
            // ⚠️ 0.8.0's profileId / profileName are dropped rather than carried across.
            // A Connection Profile id names something in SillyTavern that this tool no
            // longer talks to (ADR-0005), and the key that would make it usable — the
            // API key — lives in the server's secrets and was never readable from here.
            apiConfigId: String(command?.apiConfigId || ''),
            // null means 跟隨全域 — this command has no list of its own and uses the one
            // in settings. An array means the user has edited it, and it froze at that
            // moment (ADR-0007). ⚠️ Not `|| null`: an empty array is a real answer (the
            // user deleted every card they could delete) and must not collapse back into
            // "follow the global list".
            promptCards: Array.isArray(command?.promptCards)
                ? normalizePromptCards(command.promptCards)
                : migrateSystemPromptToCards(command?.systemPrompt),
            visible: command?.visible !== false,
        };
    }

    // 0.8.0 stored a command's 編輯原則覆寫 as one block of text that replaced the global
    // principles outright. It becomes exactly one frozen card carrying that same text,
    // with no other user card beside it — so the bytes this command sends do not change
    // on the release that introduces cards. Nothing stored means 跟隨全域.
    function migrateSystemPromptToCards(systemPrompt) {
        const text = String(systemPrompt || '').trim();
        if (!text) return null;
        return normalizePromptCards([
            { kind: 'protocol' },
            { kind: 'user', name: '編輯原則', content: `Editing principles:\n${text}`, role: 'system' },
            { kind: 'system', slot: 'instruction' },
            { kind: 'system', slot: 'reference' },
            { kind: 'system', slot: 'target' },
        ]);
    }

    // A tag turns a user card into `<name>…</name>`. Angle brackets and whitespace are
    // stripped rather than rejected: someone typing what they want the tag to look like
    // writes `<style_guide>`, and refusing that is a worse answer than understanding it.
    //
    // ⚠️ The reserved names are refused outright. search / replace / replacement are the
    // three tags the model has to emit itself, and the parser's correctness rests on
    // them; a user-made block boundary of the same name hands the parser to luck.
    function sanitizePromptTag(value) {
        const tag = String(value || '').replace(/[<>\s/]/g, '');
        if (!tag) return '';
        return RESERVED_TAGS.includes(tag.toLowerCase()) ? '' : tag;
    }

    function normalizePromptCard(card) {
        const kind = card?.kind === 'protocol' || card?.kind === 'system' ? card.kind : 'user';
        if (kind === 'protocol') return { id: 'protocol', kind: 'protocol' };
        if (kind === 'system') {
            const slot = Object.prototype.hasOwnProperty.call(SYSTEM_CARD_SLOTS, card?.slot) ? card.slot : null;
            return slot ? { id: `system-${slot}`, kind: 'system', slot } : null;
        }
        return {
            id: String(card?.id || makeId('card')),
            kind: 'user',
            name: String(card?.name || '未命名模組'),
            content: String(card?.content || ''),
            tag: sanitizePromptTag(card?.tag),
            // Only user cards choose. The protocol is a system message because that is
            // what it is, and the three generated cards ride in the user turn — those
            // roles are part of the contract, not a preference (ADR-0006).
            role: ['system', 'user', 'assistant'].includes(card?.role) ? card.role : 'user',
            enabled: card?.enabled !== false,
        };
    }

    // The factory arrangement, and the one the literal-string test in core.test.cjs
    // locks: it must assemble into exactly the bytes 0.8.0 sent.
    function defaultPromptCards() {
        return normalizePromptCards([
            { kind: 'protocol' },
            { kind: 'user', name: '編輯原則', content: DEFAULT_PRINCIPLES_CARD, role: 'system' },
            { kind: 'system', slot: 'instruction' },
            { kind: 'system', slot: 'reference' },
            { kind: 'system', slot: 'target' },
        ]);
    }

    // Rebuilds the invariant rather than trusting the stored order: 協定 first, 目標內文
    // last, exactly one of each generated card present somewhere. Stored data can be
    // hand-edited, imported from another version, or truncated — and a list missing its
    // 可編輯範圍 card would still assemble, still send, and still come back to be written
    // into the chat. The structure has to be re-established, not validated.
    //
    // ⚠️ This runs inside normalizeSettings, so it must be stable: an unstable pass would
    // shuffle the user's cards a little more on every save, with nobody touching them.
    function normalizePromptCards(raw) {
        const source = Array.isArray(raw) ? raw : [];
        const middle = [];
        const seenSlots = new Set();
        for (const entry of source) {
            const card = normalizePromptCard(entry);
            if (!card) continue;
            if (card.kind === 'protocol') continue;
            if (card.kind === 'system') {
                if (card.slot === PINNED_LAST || seenSlots.has(card.slot)) continue;
                seenSlots.add(card.slot);
            }
            middle.push(card);
        }
        // A generated card the stored list has lost is appended rather than dropped. It
        // carries text the request cannot do without, and losing 指示 silently would send
        // the model prose with no task attached.
        for (const slot of Object.keys(SYSTEM_CARD_SLOTS)) {
            if (slot === PINNED_LAST || seenSlots.has(slot)) continue;
            middle.push({ id: `system-${slot}`, kind: 'system', slot });
        }
        return [
            { id: PINNED_FIRST, kind: 'protocol' },
            ...middle,
            { id: `system-${PINNED_LAST}`, kind: 'system', slot: PINNED_LAST },
        ];
    }

    function isPinnedCard(card) {
        return card?.kind === 'protocol' || (card?.kind === 'system' && card.slot === PINNED_LAST);
    }

    // Which list a command actually sends. null means 跟隨全域 (ADR-0007).
    function resolvePromptCards(settings, command) {
        const own = command?.promptCards;
        if (Array.isArray(own)) return normalizePromptCards(own);
        return normalizePromptCards(settings?.promptCards);
    }

    // One connection the tool talks to. Everything a request needs is in here, including
    // the two generation knobs — a command that names an API 設定 takes the whole group,
    // never a field from one and a field from another (the same call ADR-0002 made).
    function normalizeApiConfig(config, index = 0) {
        const maxTokens = Number(config?.maxTokens);
        return {
            id: String(config?.id || makeId('api')),
            name: String(config?.name || `API 設定 ${index + 1}`),
            // Taken literally. Nothing is appended, nothing is guessed: /chat/completions
            // and /models are hung off whatever is here. Guessing a missing /v1 is how
            // story-oracle ended up needing a second switch to undo the first one.
            endpoint: String(config?.endpoint || '').trim().replace(/\/+$/, ''),
            apiKey: String(config?.apiKey || ''),
            model: String(config?.model || '').trim(),
            // Blank means "do not send temperature at all". Some models reject the
            // parameter outright, and a blank field says that better than a checkbox —
            // it is the same "blank means inherit, not blank means empty" this project
            // already uses everywhere else.
            temperature: config?.temperature === '' || config?.temperature === null || config?.temperature === undefined
                ? null
                : (Number.isFinite(Number(config.temperature)) ? Number(config.temperature) : null),
            maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.round(maxTokens) : 2048,
            // Per group, not global: whether a provider refuses browser requests is a
            // property of that provider, not a preference of the user's.
            viaBackend: config?.viaBackend === true,
            stream: config?.stream !== false,
            // Anything else this provider wants in the request body — reasoning switches
            // being the reason it exists. The tool never looks inside: what a provider
            // calls its thinking parameter changes often enough that a built-in checkbox
            // would be a guess with an expiry date, and an expired guess looks exactly
            // like a switch that does nothing (產品決策 5).
            extraBody: sanitizeExtraBody(config?.extraBody),
        };
    }

    function normalizeApiConfigs(raw) {
        if (!Array.isArray(raw)) return [];
        const seen = new Set();
        const list = [];
        for (const entry of raw) {
            const config = normalizeApiConfig(entry, list.length);
            if (seen.has(config.id)) config.id = makeId('api');
            seen.add(config.id);
            list.push(config);
        }
        return list;
    }

    // Which connection a command sends through: its own if it names one that still
    // exists, otherwise the default. A command pointing at a deleted API 設定 falls back
    // rather than failing — but the settings dialog says so, because a silent fallback
    // to a different model is exactly the kind of thing this project refuses to hide.
    function resolveApiConfig(settings, command) {
        const list = Array.isArray(settings?.apiConfigs) ? settings.apiConfigs : [];
        const wanted = command?.apiConfigId
            ? list.find(config => config.id === command.apiConfigId)
            : null;
        if (wanted) return wanted;
        return list.find(config => config.id === settings?.defaultApiConfigId) || list[0] || null;
    }

    // Groups are a view of the stored order, not a second ordering to keep in step with
    // it. A named group's members are gathered to wherever its first member sits, so a
    // folder is always contiguous — that is what makes it a folder.
    //
    // ⚠️ Ungrouped commands are NOT a group and are left exactly where they are. Treating
    // "" as one more group looks tidy and is wrong in use: it welds every loose command
    // into a single block, so there is no way to put one between two folders, or in front
    // of one. A loose command has to be free to sit anywhere in the row, like a bookmark
    // that is not in a folder.
    //
    // Order is otherwise preserved exactly, and it must be: this runs on every
    // normalizeSettings(), so anything unstable here would reshuffle the user's list a
    // little more on each save.
    function sortCommandsByGroup(commands) {
        const result = [];
        const placed = new Set();
        for (const command of commands) {
            if (placed.has(command)) continue;
            const group = command?.group || '';
            if (!group) {
                result.push(command);
                placed.add(command);
                continue;
            }
            for (const member of commands) {
                if (placed.has(member) || (member?.group || '') !== group) continue;
                result.push(member);
                placed.add(member);
            }
        }
        return result;
    }

    function commandGroupNames(commands) {
        const names = [];
        for (const command of commands || []) {
            const group = command?.group || '';
            if (group && !names.includes(group)) names.push(group);
        }
        return names;
    }

    // A builtin command the user has edited is stored as a complete frozen copy, keyed
    // by the preset id (ADR-0001). Anything that is not a known preset id is dropped,
    // and the id is always taken from the preset rather than from stored data: a corrupt
    // or hand-edited payload must not be able to invent a fifth builtin or rename one
    // into an orphan the settings dialog can no longer reach.
    function normalizeBuiltinOverrides(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const overrides = {};
        BUILTIN_ACTIONS.forEach((preset, index) => {
            const entry = source[preset.id];
            if (!entry || typeof entry !== 'object') return;
            overrides[preset.id] = { ...normalizeCommand({ ...preset, ...entry }, index), id: preset.id };
        });
        return overrides;
    }

    // Number(null) is 0 and Number('') is 0, both of which are finite. Feeding a
    // stored `null` straight into Number.isFinite therefore turns "no saved position"
    // into "position 0", which is why this cannot be inlined as a bare Number check:
    // settings get normalized on every save, so the second pass would pin the editor
    // to the top-left corner for good.
    function finiteOr(value, fallback) {
        if (value === null || value === undefined || value === '') return fallback;
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    // Same trap as finiteOr(): a stored `false` is a real answer and `undefined` is not,
    // so this cannot collapse to `Boolean(value) || fallback` — that would reopen every
    // section the user had deliberately folded away, on every save.
    function normalizeSidebarFlag(value, fallback) {
        return typeof value === 'boolean' ? value : fallback;
    }

    // 0.8.0's 全域編輯原則 was one textarea. It becomes the factory arrangement with that
    // text inside the 編輯原則 card — same bytes out, different container.
    function migrateGlobalPromptToCards(globalPrompt) {
        const text = String(globalPrompt ?? '').trim() || DEFAULT_GLOBAL_PROMPT;
        const cards = defaultPromptCards();
        const principles = cards.find(card => card.kind === 'user');
        if (principles) principles.content = `Editing principles:\n${text}`;
        return cards;
    }

    function normalizeSettings(raw) {
        const settings = raw && typeof raw === 'object' ? raw : {};
        const rect = settings.editorRect && typeof settings.editorRect === 'object' ? settings.editorRect : {};
        return {
            version: VERSION,
            // ⚠️ 0.8.0's defaultProfileId / defaultProfileName / defaultMaxTokens /
            // globalPrompt are read here and then gone. Dropping a key this way is safe
            // because normalizeSettings rebuilds the whole object; what must not happen
            // is an old payload making the read throw, because the catch around it hands
            // back defaults and the user's custom commands evaporate.
            apiConfigs: normalizeApiConfigs(settings.apiConfigs),
            defaultApiConfigId: String(settings.defaultApiConfigId || ''),
            // The global card list. A command with no list of its own sends this one.
            promptCards: Array.isArray(settings.promptCards)
                ? normalizePromptCards(settings.promptCards)
                : migrateGlobalPromptToCards(settings.globalPrompt),
            lastCustomMode: settings.lastCustomMode === 'replacement' ? 'replacement' : 'patch',
            // The result of the last time 檢查更新 was pressed. Remembered only so the dot
            // on the settings button survives a page reload — nothing here ever triggers a
            // request. ⚠️ There is deliberately no scheduled check and no enable switch:
            // the tool reaches the network when the button is pressed, and at no other
            // time, so there is nothing to switch off.
            updateLatestVersion: String(settings.updateLatestVersion || ''),
            // Which of the user's SillyTavern regex rules run over reference material.
            // Persistent by design: this answers "which of my rules make sense while
            // editing", a judgement that does not change from one session to the next.
            regexRuleIds: Array.isArray(settings.regexRuleIds)
                ? [...new Set(settings.regexRuleIds.map(String).filter(Boolean))]
                : [],
            // Ticked world info entries survive the editor closing. This reverses the
            // 0.5.0-development decision to make them session-scoped: in real use the
            // same background is wanted over and over, and re-ticking it every time was
            // the single biggest complaint. A book+uid pair still means the same entry
            // in another chat, which is what makes carrying it over safe.
            worldbookSelection: Array.isArray(settings.worldbookSelection)
                ? dedupeWorldbookRefs(settings.worldbookSelection.map(normalizeWorldbookRef).filter(Boolean))
                : [],
            // Reference floors are remembered too, but ONLY for the chat they were typed
            // in — a floor number means nothing outside its own chat, and floor 42 in
            // another chat is a completely different scene that the tool cannot tell
            // apart. The id is stored beside the text so a mismatch simply restores
            // nothing.
            referenceInput: String(settings.referenceInput || ''),
            referenceChatId: String(settings.referenceChatId || ''),
            builtinOverrides: normalizeBuiltinOverrides(settings.builtinOverrides),
            commands: Array.isArray(settings.commands) ? sortCommandsByGroup(settings.commands.map(normalizeCommand)) : [],
            // Which of the sidebar's three sections are expanded. Remembered because the
            // answer is a working habit, not a per-editor decision: someone who never
            // touches regex rules should not have to fold that section away every time.
            // 正則 starts closed — it is the longest list and the one changed least often.
            sidebarSections: {
                floors: normalizeSidebarFlag(settings.sidebarSections?.floors, true),
                worldbook: normalizeSidebarFlag(settings.sidebarSections?.worldbook, true),
                regex: normalizeSidebarFlag(settings.sidebarSections?.regex, false),
            },
            editorRect: {
                width: finiteOr(rect.width, 1180),
                height: finiteOr(rect.height, 720),
                left: finiteOr(rect.left, null),
                top: finiteOr(rect.top, null),
            },
        };
    }

    // The toolbar and the settings dialog must never disagree about what a command
    // actually is. Both read the builtin list from here, so the override merge that
    // 0.3.0 adds lives in one place instead of being repeated at each call site.
    function resolveCommands(settings) {
        const overrides = settings?.builtinOverrides && typeof settings.builtinOverrides === 'object'
            ? settings.builtinOverrides
            : {};
        const builtins = BUILTIN_ACTIONS.map((preset, index) => {
            const override = overrides[preset.id];
            const stored = override && typeof override === 'object' ? override : null;
            return {
                ...normalizeCommand({ ...preset, ...stored }, index),
                id: preset.id,
                builtin: true,
                modified: Boolean(stored),
            };
        });
        const source = Array.isArray(settings?.commands) ? settings.commands : [];
        const customs = source.map((command, index) => ({
            ...normalizeCommand(command, index),
            builtin: false,
        }));
        return { builtins, customs };
    }

    function createScriptVariableStore(scope, tavernObject) {
        const boundGetVariables = typeof scope.getVariables === 'function' ? scope.getVariables.bind(scope) : null;
        const boundReplaceVariables = typeof scope.replaceVariables === 'function' ? scope.replaceVariables.bind(scope) : null;
        const getScriptId = typeof scope.getScriptId === 'function' ? scope.getScriptId.bind(scope) : null;

        return {
            read() {
                if (boundGetVariables) return boundGetVariables({ type: 'script' }) || {};
                const scriptId = getScriptId?.();
                if (!scriptId) throw new Error('無法取得目前 TavernHelper 腳本 ID。');
                return tavernObject.getVariables({ type: 'script', script_id: scriptId }) || {};
            },
            write(variables) {
                if (boundReplaceVariables) {
                    boundReplaceVariables(variables, { type: 'script' });
                    return;
                }
                const scriptId = getScriptId?.();
                if (!scriptId) throw new Error('無法取得目前 TavernHelper 腳本 ID。');
                tavernObject.replaceVariables(variables, { type: 'script', script_id: scriptId });
            },
        };
    }

    // ══════ 純函式：API 端點與回應 ══════

    // ⚠️ Reserved keys are stripped here, not only in the form. Settings can arrive from
    // an imported backup or a hand-edited variable, and a `messages` key reaching the
    // request body would replace the entire protocol with whatever was in it — the one
    // failure this tool cannot afford, because the reply still comes back and still gets
    // written into the chat.
    function sanitizeExtraBody(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const clean = {};
        for (const [key, entry] of Object.entries(value)) {
            if (EXTRA_BODY_RESERVED.includes(key)) continue;
            clean[key] = entry;
        }
        return clean;
    }

    // Parses what the user typed. Returns { ok, value, blocked } or { ok: false, error }.
    // Blocked keys are reported rather than dropped in silence: someone who typed
    // `temperature` there needs to be told it has its own field, not left wondering why
    // the number they set does nothing.
    function parseExtraBody(text) {
        const raw = String(text ?? '').trim();
        if (!raw) return { ok: true, value: {}, blocked: [] };
        let parsed;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return { ok: false, error: '這不是有效的 JSON。整段要用大括號包起來，例如 {"reasoning": {"effort": "none"}}' };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, error: '最外層必須是一個物件（用 { } 包起來），不能是清單或單一數值。' };
        }
        const blocked = Object.keys(parsed).filter(key => EXTRA_BODY_RESERVED.includes(key));
        return { ok: true, value: sanitizeExtraBody(parsed), blocked };
    }

    function formatExtraBody(value) {
        const clean = sanitizeExtraBody(value);
        return Object.keys(clean).length ? JSON.stringify(clean, null, 2) : '';
    }

    // ⚠️ The endpoint is used literally. Nothing is appended to make a bare host look
    // like an API base, and no /v1 is guessed — the field is labelled 端點（基礎網址）and
    // that is taken at its word. story-oracle guesses a missing /v1 and then needs a
    // second switch (地址原樣使用) to turn the guess back off; two switches for a problem
    // it created itself.
    //
    // The one thing recognised is an exact /chat/completions suffix, and that is not a
    // guess: it is the same address spelled out in full, and pasting the full URL is what
    // a provider's own documentation usually shows.
    function endpointChatUrl(endpoint) {
        const base = String(endpoint || '').trim().replace(/\/+$/, '');
        if (!base) return '';
        return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
    }

    function endpointModelsUrl(endpoint) {
        const base = String(endpoint || '').trim().replace(/\/+$/, '');
        if (!base) return '';
        if (/\/chat\/completions$/.test(base)) return base.replace(/\/chat\/completions$/, '/models');
        return /\/models$/.test(base) ? base : `${base}/models`;
    }

    // OpenAI answers { data: [{ id }] }. Relays answer with a bare array or { models: […] }
    // often enough that refusing those would report "no models" on connections that work.
    function extractModelIds(data) {
        const list = Array.isArray(data?.data) ? data.data
            : Array.isArray(data) ? data
            : Array.isArray(data?.models) ? data.models
            : [];
        const ids = list
            .map(entry => (typeof entry === 'string' ? entry : (entry?.id || entry?.name)))
            .filter(Boolean)
            .map(String);
        return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    }

    // ⚠️ Some relays ignore `stream: true` and answer with an ordinary completion instead
    // of an event stream. Scanning that for `data:` lines finds nothing and returns an
    // empty string, which upstream reads as "the model said nothing" and silently falls
    // through to replacing the whole scope. This is the fallback that reads it as what it
    // actually is. Returns '' when the body is neither, so the caller can report an empty
    // reply honestly.
    function extractNonStreamContent(raw) {
        if (!String(raw ?? '').trim()) return '';
        try {
            const data = JSON.parse(raw);
            return String(data?.choices?.[0]?.message?.content ?? '');
        } catch {
            return '';
        }
    }

    // ⚠️ A browser refused by CORS reports `TypeError: Failed to fetch` and nothing else —
    // no status, no reason, and the console message is indistinguishable from being
    // offline. Without this translation the 經酒館伺服器代發 switch may as well not exist,
    // because the person who needs it has no way to know it is the answer.
    function describeRequestError(error, viaBackend = false) {
        const status = Number(error?.status) || 0;
        const message = String(error?.message || error || '');
        if (status === 401 || status === 403) {
            return `這組 API 設定的金鑰被拒絕了（HTTP ${status}）。請確認金鑰有沒有貼完整、有沒有過期。`;
        }
        if (status === 404) {
            return '找不到這個網址（HTTP 404）。這個工具不會幫你補網址，請對照服務商的文件看看有沒有漏掉結尾——最常見的是少了 /v1。';
        }
        if (status) return `服務商回覆 HTTP ${status}。${message}`.trim();
        if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '請求逾時。';
        if (error?.name === 'TypeError' || /failed to fetch|networkerror|load failed/i.test(message)) {
            return viaBackend
                ? '酒館的伺服器也連不上這個網址。請先確認網址沒打錯；詳細原因會出現在酒館伺服器的主控台。'
                : `連不上這個網址。最常見的原因是這個服務商不允許網頁直接連它（瀏覽器的安全限制，不是你設定錯）——請到這組 API 設定裡勾選「${BACKEND_SWITCH_LABEL}」再試一次。`;
        }
        return message || '請求失敗，但沒有回傳原因。';
    }

    // ══════ 純函式：解析模型輸出 ══════

    function stripOuterCodeFence(text) {
        const value = String(text ?? '').trim();
        const match = value.match(/^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/);
        return match ? match[1].trim() : value;
    }

    // Every import of the script gets a fresh runtime script_id, so settings never
    // carry across an upgrade (see CLAUDE.md). The payload therefore has to survive
    // being pasted into a different install: it names its own format and version so a
    // later reader can tell a real backup from an arbitrary blob of JSON.
    const SETTINGS_EXPORT_FORMAT = 'st-inline-ai-editor-settings';
    const COMMANDS_EXPORT_FORMAT = 'st-inline-ai-editor-commands';

    // ⚠️ API keys are stripped, and this is the only place that can do it. README tells
    // people to copy this code and paste it into the new version; it gets pasted into
    // notes, chat apps and help requests, and it looks like meaningless noise while
    // being a live credential. Everything else about a connection survives, so the only
    // cost is typing the key in again (ADR-0005).
    //
    // Deliberately not offered as a choice at export time: that turns a safe default
    // into a decision made in a hurry, and getting it wrong leaves no trace at all.
    function serializeSettings(settings) {
        const normalized = normalizeSettings(settings);
        return JSON.stringify({
            format: SETTINGS_EXPORT_FORMAT,
            version: VERSION,
            settings: {
                ...normalized,
                apiConfigs: normalized.apiConfigs.map(config => ({ ...config, apiKey: '' })),
            },
        }, null, 2);
    }

    // Returns either { ok: true, settings, sourceVersion } or { ok: false, error }.
    // A rejected payload must leave the caller with nothing to apply — half-importing
    // a truncated backup is worse than refusing it.
    function parseSettingsPayload(text) {
        const raw = stripOuterCodeFence(text);
        if (!raw) return { ok: false, error: '沒有貼上任何內容。' };
        let payload;
        try {
            payload = JSON.parse(raw);
        } catch {
            return { ok: false, error: '這段文字不是有效的設定資料，無法解析。請確認整段都複製到了。' };
        }
        if (payload?.format === COMMANDS_EXPORT_FORMAT) {
            return { ok: false, error: '這是「客製指令」的匯出檔，不是整包設定。請改用客製指令那一區的「匯入指令代碼」。' };
        }
        if (!payload || typeof payload !== 'object' || payload.format !== SETTINGS_EXPORT_FORMAT) {
            return { ok: false, error: '這不是 AI 內文編輯器的設定。請貼上「複製設定代碼」產生的文字。' };
        }
        if (!payload.settings || typeof payload.settings !== 'object') {
            return { ok: false, error: '設定資料缺少內容，可能複製時被截斷了。' };
        }
        return {
            ok: true,
            settings: normalizeSettings(payload.settings),
            sourceVersion: String(payload.version || ''),
        };
    }

    // Custom commands travel on their own so a set of them can be handed to someone else
    // (or kept as a separate backup) without carrying the API 設定, the prompt cards and
    // every builtin override along with it.
    //
    // ⚠️ A command's apiConfigId names something that only exists in the sender's own
    // settings, so it is dropped on import rather than kept as a dangling reference. A
    // dropped id means "use the default group", which is a real behaviour the recipient
    // can see; a kept one would point at nothing and fail only when the button is pressed.
    //
    // A distinct `format` from the whole-settings backup, so pasting one into the other's
    // box is refused with a sentence that says which box it belongs in — rather than
    // being read as a settings file with no settings in it and wiping everything.
    function serializeCommands(commands) {
        return JSON.stringify({
            format: COMMANDS_EXPORT_FORMAT,
            version: VERSION,
            commands: sortCommandsByGroup((Array.isArray(commands) ? commands : []).map(normalizeCommand)),
        }, null, 2);
    }

    // Returns { ok: true, commands, sourceVersion } or { ok: false, error }.
    //
    // ⚠️ Ids come out of here as they went in. The caller reissues them — importing is a
    // merge (the user's own commands stay), and two commands sharing an id in one list is
    // a state nothing else in the code expects.
    function parseCommandsPayload(text) {
        const raw = stripOuterCodeFence(text);
        if (!raw) return { ok: false, error: '沒有貼上任何內容。' };
        let payload;
        try {
            payload = JSON.parse(raw);
        } catch {
            return { ok: false, error: '這段文字不是有效的指令資料，無法解析。請確認整段都複製到了。' };
        }
        if (payload?.format === SETTINGS_EXPORT_FORMAT) {
            return { ok: false, error: '這是整包設定的備份，不是客製指令。請改用「設定備份」那一區的「匯入設定代碼」。' };
        }
        if (!payload || typeof payload !== 'object' || payload.format !== COMMANDS_EXPORT_FORMAT) {
            return { ok: false, error: '這不是 AI 內文編輯器的客製指令。請貼上「複製指令代碼」產生的文字。' };
        }
        if (!Array.isArray(payload.commands)) {
            return { ok: false, error: '指令資料缺少內容，可能複製時被截斷了。' };
        }
        // An empty list parses fine but has nothing to merge, and silently reporting
        // "imported 0" reads as success.
        if (!payload.commands.length) {
            return { ok: false, error: '這份匯出檔裡沒有任何客製指令。' };
        }
        return {
            ok: true,
            // ⚠️ apiConfigId is cleared on the way in. The id names a group in the
            // sender's settings and cannot exist here; keeping it would leave the command
            // pointing at nothing, and that only surfaces when the button is pressed.
            // Blank means 用預設那組 — a real, visible answer.
            commands: payload.commands.map(command => normalizeCommand({ ...command, apiConfigId: '' })),
            sourceVersion: String(payload.version || ''),
        };
    }

    function parseSearchReplacePairs(response) {
        const pairs = [];
        const regex = /<search>([\s\S]*?)<\/search>\s*<replace>([\s\S]*?)<\/replace>/gi;
        let match;
        while ((match = regex.exec(String(response ?? ''))) !== null) {
            if (!match[1].trim()) continue;
            pairs.push({ search: match[1], replace: match[2] });
        }
        return pairs;
    }

    function applySearchReplacePairs(scopeText, pairs) {
        let output = String(scopeText ?? '');
        const applied = [];
        const skipped = [];
        for (const pair of pairs) {
            // Match verbatim first: a model may include surrounding whitespace to
            // pick out one of several identical passages. Trimming that away would
            // silently rewrite the wrong one. Trim only as a fallback, and trim both
            // sides together so the replacement stays aligned with what matched.
            let search = pair.search;
            let replace = pair.replace;
            let index = output.indexOf(search);
            if (index === -1) {
                search = pair.search.trim();
                replace = pair.replace.trim();
                index = output.indexOf(search);
            }
            if (index === -1) {
                skipped.push(pair);
                continue;
            }
            output = `${output.slice(0, index)}${replace}${output.slice(index + search.length)}`;
            applied.push(pair);
        }
        return { text: output, applied, skipped };
    }

    const SKIPPED_PREVIEW_LIMIT = 3;

    function previewText(value) {
        const text = String(value ?? '').replace(/\s+/g, ' ').trim();
        return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    }

    // `hasReference` arrives as an argument rather than being read from state: this
    // function sits in the pure-function region that Node can load, and reaching for
    // state here would break every test in the file.
    function parseAiResponse(response, requestedMode, scopeText, hasReference = false) {
        const raw = stripOuterCodeFence(response);
        const warnings = [];

        if (requestedMode === 'patch') {
            const pairs = parseSearchReplacePairs(raw);
            if (pairs.length) {
                const searchTagCount = (raw.match(/<search>/gi) || []).length;
                const replaceTagCount = (raw.match(/<replace>/gi) || []).length;
                const malformedCount = Math.max(searchTagCount, replaceTagCount) - pairs.length;
                const result = applySearchReplacePairs(scopeText, pairs);
                if (malformedCount > 0) {
                    warnings.push(`有 ${malformedCount} 項修補格式不完整，已跳過。`);
                }
                if (result.skipped.length) {
                    warnings.push(`有 ${result.skipped.length} 項修補找不到原文，已跳過。`);
                    // A free diagnostic lead rather than an up-front warning: there is
                    // no evidence that reference material raises the miss rate, and a
                    // permanent "this might fail" notice would just become noise. Once
                    // something has actually missed, saying where to look is cheap.
                    if (hasReference) {
                        warnings.push('這次帶了參考資料，模型可能是從參考資料裡取原文。');
                    }
                    // Name the text that missed, so a near-miss (a quotation mark the
                    // model balanced, a character it normalised) is visible instead of
                    // hiding behind a count.
                    for (const pair of result.skipped.slice(0, SKIPPED_PREVIEW_LIMIT)) {
                        warnings.push(`找不到這段：${previewText(pair.search)}`);
                    }
                }
                return {
                    kind: 'patch',
                    text: result.text,
                    raw,
                    appliedCount: result.applied.length,
                    skippedCount: result.skipped.length,
                    warnings,
                };
            }

            warnings.push('模型未遵守局部修補格式，已改用全文替換預覽。');
            return {
                kind: 'fallback-replacement',
                text: raw,
                raw,
                appliedCount: 0,
                skippedCount: 0,
                warnings,
            };
        }

        const replacement = raw.match(/<replacement>([\s\S]*?)<\/replacement>/i);
        if (replacement) {
            return {
                kind: 'replacement',
                text: replacement[1].trim(),
                raw,
                appliedCount: 1,
                skippedCount: 0,
                warnings,
            };
        }

        warnings.push('模型未使用 replacement 標籤，已把完整回覆當作替換內容。');
        return {
            kind: 'fallback-replacement',
            text: raw,
            raw,
            appliedCount: 1,
            skippedCount: 0,
            warnings,
        };
    }

    function applyScope(fullText, start, end, newScopeText) {
        return `${fullText.slice(0, start)}${newScopeText}${fullText.slice(end)}`;
    }

    // ══════ 純函式：差異比對與逐行取捨 ══════

    function tokenizeForDiff(value) {
        return String(value ?? '').match(/(\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[A-Za-z0-9_]+|[^\s])/gu) || [];
    }

    function lcsOps(a, b, equals, cellLimit = 350000) {
        const n = a.length;
        const m = b.length;
        if (n * m > cellLimit) {
            return [
                ...a.map(value => ({ type: 'remove', value })),
                ...b.map(value => ({ type: 'add', value })),
            ];
        }
        const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i -= 1) {
            for (let j = m - 1; j >= 0; j -= 1) {
                dp[i][j] = equals(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        const ops = [];
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (equals(a[i], b[j])) {
                ops.push({ type: 'equal', value: a[i] });
                i += 1;
                j += 1;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                ops.push({ type: 'remove', value: a[i++] });
            } else {
                ops.push({ type: 'add', value: b[j++] });
            }
        }
        while (i < n) ops.push({ type: 'remove', value: a[i++] });
        while (j < m) ops.push({ type: 'add', value: b[j++] });
        return ops;
    }

    function pairLineOps(ops) {
        const rows = [];
        let index = 0;
        while (index < ops.length) {
            if (ops[index].type === 'equal') {
                rows.push({ type: 'equal', original: ops[index].value, proposed: ops[index].value });
                index += 1;
                continue;
            }
            const removed = [];
            const added = [];
            while (index < ops.length && ops[index].type === 'remove') removed.push(ops[index++].value);
            while (index < ops.length && ops[index].type === 'add') added.push(ops[index++].value);
            const length = Math.max(removed.length, added.length);
            for (let offset = 0; offset < length; offset += 1) {
                rows.push({
                    type: 'changed',
                    original: removed[offset] ?? '',
                    proposed: added[offset] ?? '',
                    removeOnly: offset >= added.length,
                    addOnly: offset >= removed.length,
                });
            }
        }
        return rows;
    }

    function computeDiffRows(original, proposed) {
        const originalLines = String(original ?? '').split('\n');
        const proposedLines = String(proposed ?? '').split('\n');
        const ops = lcsOps(originalLines, proposedLines, (a, b) => a === b);
        return pairLineOps(ops);
    }

    // Rebuilds the scope from a per-row decision: a ticked row contributes its
    // proposed line, an unticked one its original.
    //
    // Selecting at this layer rather than at the patch layer is what makes partial
    // acceptance safe. The patches run exactly once, before any of this, so nothing
    // a user ticks can change whether a patch matched. Re-running applySearchReplacePairs
    // per subset would not have that property: two patches whose search strings
    // overlap in the source make one patch's fate depend on which others are in play,
    // so dropping one could silently flip another between applied and skipped.
    //
    // A row with no original (a pure insertion) and a row with no proposed (a pure
    // deletion) each contribute nothing on their rejected side rather than an empty
    // string — otherwise declining an insertion would leave a blank line where
    // nothing was ever inserted.
    function composeSelectedRows(rows, selected = null) {
        const out = [];
        rows.forEach((row, index) => {
            if (row.type === 'equal') {
                out.push(row.original);
                return;
            }
            if (!selected || selected[index] !== false) {
                if (!row.removeOnly) out.push(row.proposed);
            } else if (!row.addOnly) {
                out.push(row.original);
            }
        });
        return out.join('\n');
    }

    // ══════ 純函式：參考樓層範圍 ══════

    const FLOOR_TOKEN = /^(\d+)(?:\s*-\s*(\d+))?$/;

    // A runaway guard, not a product limit. It only bites when the chat length is
    // unknown, because a known length already clamps every range.
    const RANGE_EXPANSION_LIMIT = 2000;

    // Turns "30, 42-46" into the floor ids to fetch. Everything the caller needs in
    // order to *show* what happened comes back too: this project does not drop input
    // quietly. The host is no help here — getChatMessages('30, 42-46') returns an
    // empty array without throwing, and '0-9999' silently clamps to the whole chat,
    // so both the splitting and the range checking have to happen right here.
    function parseFloorRange(input, options = {}) {
        const maxId = Number.isInteger(options.maxMessageId) ? options.maxMessageId : null;
        const excludeId = Number.isInteger(options.excludeId) ? options.excludeId : null;
        const invalid = [];
        const outOfRange = [];
        const seen = new Set();
        const ids = [];
        let excluded = false;
        let truncated = false;

        for (const rawToken of String(input ?? '').split(',')) {
            const token = rawToken.trim();
            if (!token) continue;
            const match = token.match(FLOOR_TOKEN);
            if (!match) {
                invalid.push(token);
                continue;
            }
            const first = Number(match[1]);
            const second = match[2] === undefined ? first : Number(match[2]);
            // A reversed range is an obvious typo with an obvious intent; read it the
            // way it was meant rather than making the user notice the order.
            const from = Math.min(first, second);
            const to = Math.max(first, second);
            if (maxId !== null && to > maxId) outOfRange.push(token);
            const upper = maxId === null ? to : Math.min(to, maxId);
            for (let id = from; id <= upper; id += 1) {
                if (id === excludeId) {
                    excluded = true;
                    continue;
                }
                if (seen.has(id)) continue;
                if (ids.length >= RANGE_EXPANSION_LIMIT) {
                    truncated = true;
                    break;
                }
                seen.add(id);
                ids.push(id);
            }
        }

        ids.sort((a, b) => a - b);
        return { ids, excluded, invalid, outOfRange, truncated };
    }

    // Contiguous runs, so a 40-floor selection costs a handful of host calls instead
    // of forty. Also what the collapsed summary line is written from.
    function idsToRanges(ids) {
        const sorted = [...new Set((ids || []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
        const ranges = [];
        for (const id of sorted) {
            const last = ranges[ranges.length - 1];
            if (last && id === last.to + 1) last.to = id;
            else ranges.push({ from: id, to: id });
        }
        return ranges;
    }

    function formatFloorRanges(ids) {
        return idsToRanges(ids)
            .map(range => (range.from === range.to ? String(range.from) : `${range.from}-${range.to}`))
            .join('、');
    }

    // SillyTavern stores a rule's pattern as a /pattern/flags literal (verified on a
    // live install), so it cannot be handed straight to RegExp.
    // ══════ 純函式：正則規則 ══════

    function parseRegexLiteral(source) {
        const text = String(source ?? '').trim();
        if (!text) return null;
        const match = text.match(/^\/([\s\S]+)\/([a-z]*)$/);
        return match ? { pattern: match[1], flags: match[2] } : { pattern: text, flags: '' };
    }

    function filterTrimStrings(value, trimStrings) {
        let text = String(value ?? '');
        for (const trim of trimStrings || []) {
            const needle = String(trim ?? '');
            if (needle) text = text.split(needle).join('');
        }
        return text;
    }

    // `{{match}}` is the regex feature that stands for the whole match; it is not one
    // of SillyTavern's `{{user}}`-style macros and is handled here. Everything else in
    // double braces is a macro this tool deliberately leaves alone (ADR-0003), so it
    // has to be excluded before deciding whether a rule needs the macro warning.
    function ruleUsesMacro(rule) {
        const strip = value => String(value ?? '').replace(/\{\{match\}\}/gi, '');
        return /\{\{/.test(strip(rule?.find_regex)) || /\{\{/.test(strip(rule?.replace_string));
    }

    // The checkbox is the only knob: a checked rule runs regardless of the depth,
    // source, destination or enabled state it carries (ADR-0003). That is deliberate,
    // but it was also silent — and a rule's own name usually advertises the very
    // condition being disregarded ("5楼以下…", "以前的用户输入"). Worse, reference
    // material is user floors and AI floors mixed together, so a rule written for one
    // source is guaranteed to meet the other.
    //
    // These marks do not change what runs. They say, before the box is ticked, which
    // of the rule's own conditions this tool is about to walk past.
    function describeRuleOverrides(rule) {
        const marks = [];
        const destination = rule?.destination && typeof rule.destination === 'object' ? rule.destination : {};

        // Deliberately a typeof check: min_depth is `number | null`, and Number(null)
        // is a perfectly finite 0 — the same trap finiteOr() exists to avoid.
        if (typeof rule?.min_depth === 'number' || typeof rule?.max_depth === 'number') {
            marks.push('原本限定樓層深度，本工具會忽略、對所有參考樓層套用');
        }
        if (!destination.prompt) {
            marks.push('原本不送進提示詞（多半是畫面美化用），套上去可能把版面標記混進參考資料');
        }
        return marks;
    }

    // `source` is the one condition this tool honours, and the reason it is different
    // from depth is worth stating: depth says *when* a rule should run, but source
    // declares *what kind of text it was written for*. Reference material is user
    // floors and AI floors mixed together, so ignoring it is wrong about half of them
    // by construction.
    //
    // It is also the only condition a user cannot work around by writing their own
    // rule. A regex only ever sees a floor's text, never who wrote it — so "strip this
    // from my own lines only" is not merely awkward to express, it is impossible.
    // That is what makes this different from depth, where writing a purpose-built rule
    // is a perfectly good answer. See ADR-0003.
    // `world_info` is not a floor role — it is the role passed for world info entries,
    // whose source in SillyTavern's own vocabulary is exactly that. Same principle as
    // above: an entry is world info text, so a rule written for user input has no
    // business rewriting it.
    const REGEX_SOURCE_BY_ROLE = { user: 'user_input', assistant: 'ai_output', world_info: 'world_info' };

    function ruleAppliesToRole(rule, role) {
        const source = rule?.source;
        // No usable declaration is not a restriction — do not let a malformed rule
        // silently become one that never runs.
        if (!source || typeof source !== 'object') return true;
        const key = REGEX_SOURCE_BY_ROLE[role];
        return key ? Boolean(source[key]) : false;
    }

    // Null when the rule covers both roles, so the caller can leave the row uncluttered.
    function describeRuleScope(rule) {
        const source = rule?.source && typeof rule.source === 'object' ? rule.source : null;
        if (!source || (source.user_input && source.ai_output)) return null;
        if (source.user_input) return '只套用在使用者樓層';
        if (source.ai_output) return '只套用在 AI 樓層';
        return '不套用在任何參考樓層';
    }

    // `role` is the role of the floor this text came from. Pass `undefined` only when
    // the caller genuinely does not know it — that skips the source check entirely.
    function applyTavernRegexes(text, rules, role) {
        let output = String(text ?? '');
        const failed = [];
        let applied = 0;
        for (const rule of rules || []) {
            if (role !== undefined && !ruleAppliesToRole(rule, role)) continue;
            applied += 1;
            const literal = parseRegexLiteral(rule?.find_regex);
            if (!literal) continue;
            let regex;
            try {
                regex = new RegExp(literal.pattern, literal.flags);
            } catch {
                // A pattern this host accepted but this browser rejects must not take
                // the whole feature down with it, and must not vanish either.
                failed.push(String(rule?.script_name || rule?.id || '未命名規則'));
                continue;
            }
            const template = String(rule?.replace_string ?? '').replace(/\{\{match\}\}/gi, '$0');
            const trims = Array.isArray(rule?.trim_strings) ? rule.trim_strings : [];
            try {
                output = output.replace(regex, (...args) => {
                    const groups = typeof args[args.length - 1] === 'object' ? args[args.length - 1] : null;
                    const positional = args.slice(0, groups ? -3 : -2);
                    return template.replace(/\$(\d+)|\$<([^>]+)>/g, (whole, index, name) => {
                        const captured = name === undefined ? positional[Number(index)] : groups?.[name];
                        return captured === undefined ? whole : filterTrimStrings(captured, trims);
                    });
                });
            } catch {
                failed.push(String(rule?.script_name || rule?.id || '未命名規則'));
            }
        }
        return { text: output, failed, applied };
    }

    // ══════ 純函式：世界書條目 ══════

    // A world info entry's uid is only unique inside its own book — the host's own type
    // says so outright — so nothing may key on the uid alone.
    //
    // ⚠️ JSON, not a separator character. A book name can contain anything a filename can,
    // so any single character picked as a separator can also appear inside a name, and
    // then two different entries collide into one key — silently, showing as "ticked A,
    // sent B". JSON.stringify escapes whatever the name contains, so no pair of inputs
    // can produce the same output.
    //
    // Until 0.7.0 this was a NUL byte, which was collision-proof for the same reason but
    // made the whole source file binary as far as grep, `file` and friends were concerned:
    // `grep -c function inline-ai-editor.js` answered *nothing at all* rather than
    // admitting it could not read the file. That is precisely the failure this project
    // refuses to ship. Do not reintroduce a raw control character here.
    function worldbookEntryKey(book, uid) {
        return JSON.stringify([String(book ?? ''), String(uid ?? '')]);
    }

    // The stored form is { book, uid } rather than the joined key, because settings are
    // user-facing: they travel through the copy/paste backup, where a joined key would be
    // one opaque string instead of two readable fields. It also means changing the key
    // format — as 0.7.0 did — cannot invalidate anyone's saved picks.
    function normalizeWorldbookRef(raw) {
        const book = String(raw?.book ?? '');
        const uid = worldbookUid(raw?.uid);
        if (!book || uid === null) return null;
        return { book, uid };
    }

    // ⚠️ Not a bare Number() check. Number(null) and Number('') are both a perfectly
    // finite 0, and 0 is a real uid — so a missing uid would quietly become a pick
    // aimed at the first entry of the book. Same trap finiteOr() exists to avoid.
    function worldbookUid(value) {
        if (value === null || value === undefined || value === '') return null;
        const uid = Number(value);
        return Number.isFinite(uid) ? uid : null;
    }

    function dedupeWorldbookRefs(refs) {
        const seen = new Map();
        for (const ref of refs || []) {
            if (ref) seen.set(worldbookEntryKey(ref.book, ref.uid), ref);
        }
        return [...seen.values()];
    }

    // Keeps only the fields this tool uses, and tolerates a malformed entry rather than
    // letting one bad record take a whole book down. Returns null when the entry has no
    // usable uid: without one it cannot be selected, and a row nobody can tick is worse
    // than a row that is not there.
    function normalizeWorldbookEntry(raw, book) {
        const uid = worldbookUid(raw?.uid);
        if (uid === null) return null;
        const strategy = raw?.strategy && typeof raw.strategy === 'object' ? raw.strategy : {};
        // `keys` is `(string | RegExp)[]` in the host's type. String() on a RegExp gives
        // back its literal form, which is exactly what should be shown and searched.
        const keys = Array.isArray(strategy.keys) ? strategy.keys.map(String).filter(Boolean) : [];
        return {
            key: worldbookEntryKey(book, uid),
            book: String(book ?? ''),
            uid,
            name: String(raw?.name ?? '').trim(),
            enabled: raw?.enabled !== false,
            type: ['constant', 'selective', 'vectorized'].includes(strategy.type) ? strategy.type : 'selective',
            keys,
            content: String(raw?.content ?? ''),
        };
    }

    // States which of the entry's own conditions this tool is walking past, in the same
    // spirit as describeRuleOverrides(): ticking the box is the only knob, so the row
    // has to say what the box is overriding before it is ticked.
    function describeWorldbookEntry(entry) {
        const marks = [];
        if (entry?.type === 'constant') marks.push('藍燈（常駐）');
        else if (entry?.type === 'vectorized') marks.push('向量化');
        else marks.push('綠燈（關鍵字）');
        if (entry?.enabled === false) marks.push('SillyTavern 裡已停用');
        const keys = Array.isArray(entry?.keys) ? entry.keys : [];
        if (keys.length) marks.push(`關鍵字：${keys.slice(0, 3).join('、')}${keys.length > 3 ? '…' : ''}`);
        return marks;
    }

    function filterWorldbookEntries(entries, query) {
        const needle = String(query ?? '').trim().toLowerCase();
        if (!needle) return [...(entries || [])];
        return (entries || []).filter(entry => {
            if (String(entry?.name ?? '').toLowerCase().includes(needle)) return true;
            if (String(entry?.book ?? '').toLowerCase().includes(needle)) return true;
            return (entry?.keys || []).some(key => String(key).toLowerCase().includes(needle));
        });
    }

    // `角色: 內容` rather than bare text, and numbered so the model can tell how far
    // apart two excerpts sit. Sorted oldest first, which also puts the excerpt nearest
    // the edited floor closest to the end, where weight is highest.
    //
    // World info comes before the floors for the same reason: setting is background,
    // floors are the story, and the floors sit nearer the thing being edited.
    //
    // ⚠️ Zero regression: with no world info entries this must produce exactly the
    // string 0.4.0 produced. Both kinds share one wrapper and one identity paragraph —
    // a second wrapper would mean repeating "read-only, never take search text from
    // this" a third time, and it is already said in the protocol and here.
    // ══════ 純函式：組裝提示詞 ══════

    function buildReferenceBlock(entries, worldbookEntries) {
        const books = (worldbookEntries || []).filter(entry => String(entry?.content ?? '').length);
        const rows = (entries || []).filter(entry => String(entry?.text ?? '').length);
        if (!books.length && !rows.length) return '';
        const sections = [];
        if (books.length) {
            sections.push(books
                .map(entry => `[world info: ${entry.book}] ${entry.name || '(untitled)'}:\n${entry.content}`)
                .join('\n\n'));
        }
        if (rows.length) {
            sections.push(rows.map(entry => `[#${entry.id}] ${entry.name || '未知'}:\n${entry.text}`).join('\n\n'));
        }
        return [
            MARK.referenceOpen,
            REFERENCE_IDENTITY,
            '',
            sections.join('\n\n'),
            MARK.referenceClose,
        ].join('\n');
    }

    // ⚠️ Zero regression: with no reference material this must produce exactly what
    // 0.3.0 produced, apart from the markers now being full-width. The reminder line,
    // the extra protocol sentence and the reference block all appear only when there
    // is reference material to justify them — otherwise this release would quietly
    // change the behaviour of every existing command.
    // What each card turns into at send time. null means the card contributes nothing —
    // an emptied user card, a disabled one, or 參考資料 with nothing ticked.
    function renderPromptCard(card, parts) {
        if (card.kind === 'protocol') return { role: 'system', content: parts.protocol };
        if (card.kind === 'system') {
            if (card.slot === 'instruction') return { role: 'user', content: parts.instruction };
            if (card.slot === 'reference') return parts.reference ? { role: 'user', content: parts.reference } : null;
            return { role: 'user', content: parts.target };
        }
        if (card.enabled === false) return null;
        const body = String(card.content ?? '');
        if (!body.trim()) return null;
        return {
            role: card.role,
            content: card.tag ? `<${card.tag}>\n${body}\n</${card.tag}>` : body,
        };
    }

    // ⚠️ Adjacent same-role cards merge into ONE message, joined by a blank line. This is
    // not tidying: two consecutive messages of the same role are refused outright by some
    // endpoints, and the blank line is what makes the default arrangement reproduce
    // 0.8.0's bytes exactly (協定 + 編輯原則 in one system message, 指示 + 參考資料 +
    // 內文 in one user message).
    function mergePromptMessages(pieces) {
        const messages = [];
        for (const piece of pieces) {
            if (!piece) continue;
            const last = messages[messages.length - 1];
            if (last && last.role === piece.role) last.content += `\n\n${piece.content}`;
            else messages.push({ role: piece.role, content: piece.content });
        }
        return messages;
    }

    // ⚠️ Zero regression: with the factory card arrangement and no reference material this
    // must produce exactly what 0.3.0 produced, apart from the markers now being
    // full-width. The reminder line, the extra protocol sentence and the reference block
    // all appear only when there is reference material to justify them — otherwise this
    // release would quietly change the behaviour of every existing command.
    //
    // core.test.cjs locks that with a hand-typed literal string. The expected value is
    // deliberately NOT assembled from the MARK constants — otherwise changing a marker
    // would make the test pass in self-consistent agreement with the bug.
    function buildPrompt(action, scope, role, options = {}) {
        const reference = String(options.referenceBlock ?? '').trim();
        const cards = normalizePromptCards(options.cards);
        const instruction = action.instruction.trim();
        const scopeLabel = scope.hasSelection ? 'a selected passage' : 'the whole message';
        const contextBlocks = scope.hasSelection
            ? [
                MARK.targetOpen,
                scope.fullText,
                MARK.targetClose,
                '',
                MARK.scopeOpen,
                scope.text,
                MARK.scopeClose,
            ]
            : [
                MARK.fullScopeOpen,
                scope.text,
                MARK.fullScopeClose,
            ];
        const parts = {
            protocol: reference && action.mode === 'patch'
                ? `${LOCKED_PROTOCOL.patch}\n${PATCH_REFERENCE_RULE}`
                : LOCKED_PROTOCOL[action.mode],
            instruction: [
                `Task: ${instruction}`,
                `The editable scope is ${scopeLabel} written by the ${role}.`,
            ].join('\n'),
            reference,
            // The reminder rides on the pinned last card rather than being a card of its
            // own. It is a restatement of Task:, and its only reason to exist is that a
            // long stretch of reference material sits between the two — a draggable card
            // could be dropped right under 指示, saying the same sentence twice with
            // nothing in between (ADR-0006).
            target: contextBlocks.join('\n') + (reference ? `\n\nReminder — your task: ${instruction}` : ''),
        };
        return mergePromptMessages(cards.map(card => renderPromptCard(card, parts)));
    }

    // ══════ 純函式：更新檢查 ══════

    function compareVersions(left, right) {
        const parse = value => String(value ?? '').split('.').map(part => Number.parseInt(part, 10) || 0);
        const a = parse(left);
        const b = parse(right);
        for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
            const difference = (a[index] || 0) - (b[index] || 0);
            if (difference) return difference > 0 ? 1 : -1;
        }
        return 0;
    }

    // The same expression tools/build-import.cjs and the tests use to find the version.
    // Three readers, one spelling — change one and the others stop agreeing in silence.
    //
    // ⚠️ The capture must start with digits, and that is not tidiness. This very line is
    // part of the source being searched, so a pattern of `'([^']+)'` matches its own
    // spelling here and hands back `([^` as the version. Harmless while the real constant
    // is above it, silently wrong the moment that constant is renamed.
    function readVersionFromSource(source) {
        return String(source ?? '').match(/const VERSION = '(\d+\.\d+\.\d+[^']*)'/)?.[1] || '';
    }

    // The whole new script is already in hand when 檢查更新 runs — fetchUpdateSource
    // downloads the file and readVersionFromSource picks the number out of it. So the
    // notes for the version being offered come out of the same download, with no second
    // request. Reading only the local constant would be backwards: it can only ever
    // describe the version already installed, which is no help in deciding whether to
    // update.
    //
    // ⚠️ Same trap as readVersionFromSource, and for the same reason: this regex literal
    // contains the text `const CHANGELOG = ` and is itself part of the source being
    // searched. The capture must start with a digit so the pattern cannot match its own
    // spelling and hand back its own regex as the release notes.
    function readChangelogFromSource(source) {
        return String(source ?? '').match(/const CHANGELOG = `(\d[\s\S]*?)`;/)?.[1] || '';
    }

    // A version heading is a bare `x.y.z` on its own line; everything under it belongs to
    // that release. Anything before the first heading is discarded rather than guessed at.
    function parseChangelog(text) {
        const entries = [];
        for (const line of String(text ?? '').split('\n')) {
            const heading = line.match(/^(\d+\.\d+\.\d+[^\s]*)\s*$/);
            if (heading) {
                entries.push({ version: heading[1], notes: [] });
                continue;
            }
            const note = line.replace(/^-\s*/, '').trim();
            if (note && entries.length) entries[entries.length - 1].notes.push(note);
        }
        return entries;
    }

    // Everything newer than what is installed, newest first. An empty result after a
    // successful check means the notes could not be read, not that nothing changed —
    // the caller says so rather than showing an empty box.
    function changelogSince(text, currentVersion) {
        return parseChangelog(text).filter(entry => compareVersions(entry.version, currentVersion) > 0);
    }

    // Everything that is checked before a byte of downloaded code is allowed near the
    // script library. Not a security boundary — a repository that ships bad code passes
    // all of this — but it does stop the ordinary failures: a truncated download, a
    // captive portal, a 404 page served as 200, or the right file from the wrong project.
    function inspectUpdateSource(source, currentVersion) {
        const text = String(source ?? '');
        if (!text.trim()) return { ok: false, error: '更新來源回傳空白內容，已中止。' };
        if (text.length < UPDATE_MIN_LENGTH) {
            return { ok: false, error: `抓到的內容只有 ${text.length.toLocaleString('en-US')} 字元，不像完整的腳本，已中止。` };
        }
        if (!text.includes('bootstrapInlineAiEditor') || !text.includes(SETTINGS_KEY)) {
            return { ok: false, error: '抓到的內容不是 AI 內文編輯器的腳本，已中止。' };
        }
        const version = readVersionFromSource(text);
        if (!version) return { ok: false, error: '抓到的內容裡讀不到版號，已中止。' };
        return { ok: true, version, newer: compareVersions(version, currentVersion) > 0 };
    }

    // ══════ 測試出口（之前不得有 await） ══════

    const TEST_API = {
        normalizeSettings,
        normalizeBuiltinOverrides,
        sortCommandsByGroup,
        commandGroupNames,
        resolveCommands,
        serializeSettings,
        parseSettingsPayload,
        serializeCommands,
        parseCommandsPayload,
        createScriptVariableStore,
        parseSearchReplacePairs,
        applySearchReplacePairs,
        parseAiResponse,
        applyScope,
        tokenizeForDiff,
        computeDiffRows,
        composeSelectedRows,
        parseFloorRange,
        idsToRanges,
        formatFloorRanges,
        parseRegexLiteral,
        ruleUsesMacro,
        describeRuleOverrides,
        describeRuleScope,
        ruleAppliesToRole,
        applyTavernRegexes,
        worldbookEntryKey,
        normalizeWorldbookRef,
        dedupeWorldbookRefs,
        normalizeWorldbookEntry,
        describeWorldbookEntry,
        filterWorldbookEntries,
        buildReferenceBlock,
        buildPrompt,
        renderPromptCard,
        mergePromptMessages,
        normalizePromptCard,
        normalizePromptCards,
        defaultPromptCards,
        sanitizePromptTag,
        isPinnedCard,
        resolvePromptCards,
        migrateGlobalPromptToCards,
        migrateSystemPromptToCards,
        normalizeApiConfig,
        normalizeApiConfigs,
        resolveApiConfig,
        endpointChatUrl,
        endpointModelsUrl,
        sanitizeExtraBody,
        parseExtraBody,
        formatExtraBody,
        requestBody,
        backendPayload,
        EXTRA_BODY_RESERVED,
        extractModelIds,
        extractNonStreamContent,
        describeRequestError,
        compareVersions,
        readVersionFromSource,
        readChangelogFromSource,
        BACKEND_SWITCH_LABEL,
        parseChangelog,
        changelogSince,
        inspectUpdateSource,
        MARK,
        CHANGELOG,
    };

    if (globalScope.__STIAE_TEST__) {
        globalScope.__STIAE_TEST_API__ = TEST_API;
        return;
    }

    const hostWindow = globalScope.parent?.document ? globalScope.parent : globalScope;
    const hostDocument = hostWindow.document;
    const tavern = globalScope.TavernHelper || hostWindow.TavernHelper;
    const $ = hostWindow.jQuery || globalScope.jQuery;

    if (!hostDocument || !tavern || !$) {
        console.error('[ST Inline AI Editor] TavernHelper or the SillyTavern document is unavailable.');
        return;
    }

    const previousInstance = hostWindow[INSTANCE_KEY];
    if (previousInstance?.destroy) previousInstance.destroy();

    const state = {
        settings: null,
        activeEditor: null,
        activeReview: null,
        activeSettings: null,
        activeConfirm: null,
        activeWorldbook: null,
        // The two windows the sidebar opens. Both are read-only lookups, and both are on
        // this list for the same reason as activeWorldbook: Escape has to close the window
        // being looked at, not the editor holding the draft behind it.
        activeTextPreview: null,
        activeRequestPreview: null,
        observer: null,
        destroyed: false,
        cleanup: [],
        // latest is what the last check saw; it is also restored from settings on
        // startup so the notice survives a page reload without asking GitHub again.
        update: { checking: false, installing: false, checked: false, latest: '', error: '', changelog: '' },
        // Set while the settings dialog is open so a check that finishes can redraw its
        // own section. Null the rest of the time — this feature must not keep the dialog
        // alive after it closes.
        updateRender: null,
    };
    const variableStore = createScriptVariableStore(globalScope, tavern);

    // ══════ 宿主繫結、狀態與共用小工具 ══════

    function toast(type, message) {
        const service = hostWindow.toastr || globalScope.toastr;
        if (service?.[type]) service[type](message);
        else console[type === 'error' ? 'error' : 'log'](`[ST Inline AI Editor] ${message}`);
    }

    function createElement(tag, className = '', text = '') {
        const element = hostDocument.createElement(tag);
        if (className) element.className = className;
        if (text !== '') element.textContent = text;
        return element;
    }

    function button(label, icon = '', className = '') {
        const element = createElement('button', `menu_button stiae-button ${className}`.trim());
        element.type = 'button';
        if (icon) element.append(createElement('i', `fa-solid ${icon}`));
        element.append(createElement('span', '', label));
        return element;
    }

    function readSettings() {
        try {
            const variables = variableStore.read();
            return normalizeSettings(variables[SETTINGS_KEY]);
        } catch (error) {
            console.error('[ST Inline AI Editor] Could not read settings.', error);
            return normalizeSettings();
        }
    }

    function saveSettings() {
        try {
            const variables = variableStore.read();
            variables[SETTINGS_KEY] = clone(state.settings);
            variableStore.write(variables);
        } catch (error) {
            console.error('[ST Inline AI Editor] Could not save settings.', error);
            toast('error', '無法儲存編輯器設定。');
        }
    }

    function getContext() {
        return globalScope.SillyTavern?.getContext?.() || hostWindow.SillyTavern?.getContext?.();
    }

    // ⚠️ A stored id that no longer names anything gets its own visible option rather
    // than resetting the select to blank. Blank means 用預設那組, which is a real answer
    // — quietly turning "the group I chose is gone" into "use the default one" swaps the
    // model out from under the command with nothing on screen to show for it.
    function addApiConfigOptions(select, selectedId, includeInherit = false) {
        select.replaceChildren();
        const configs = state.settings.apiConfigs;
        const empty = createElement('option', '', includeInherit ? '用預設的那一組' : '請選擇一組 API 設定');
        empty.value = '';
        select.append(empty);
        for (const config of configs) {
            const option = createElement('option', '', config.name);
            option.value = config.id;
            select.append(option);
        }
        if (selectedId && !configs.some(config => config.id === selectedId)) {
            const missing = createElement('option', '', '⚠ 這組 API 設定已被刪除');
            missing.value = selectedId;
            select.append(missing);
        }
        select.value = selectedId || '';
        return configs;
    }

    // ══════ 樣式表 ══════

    function injectStyles() {
        hostDocument.getElementById(STYLE_ID)?.remove();
        const style = createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* ⚠️ --stiae-muted must NOT be SmartThemeQuoteColor. That variable is an
               accent — on plenty of themes it is a saturated orange — and every piece of
               explanatory text in this tool uses --stiae-muted. Pointing it at the accent
               made the help text louder than the headings it sits under, and made the
               reference rows blend into everything else. It is now the body colour faded,
               so it follows the theme while staying quieter than the text it explains.
               The flat colour on the line before is the fallback for browsers without
               color-mix(); the second declaration simply wins where it is supported. */
            .${ROOT_CLASS} { --stiae-bg: var(--SmartThemeBlurTintColor, #24242a); --stiae-fg: var(--SmartThemeBodyColor, #eee); --stiae-border: var(--SmartThemeBorderColor, #666); --stiae-accent: var(--SmartThemeQuoteColor, #7aa2d8); --stiae-muted: #9aa3b2; --stiae-muted: color-mix(in srgb, var(--SmartThemeBodyColor, #eee) 58%, transparent); color: var(--stiae-fg); font-size: var(--mainFontSize, 15px); }
            .stiae-overlay { position: fixed; inset: 0; z-index: 45000; background: rgba(0,0,0,.58); display: flex; align-items: center; justify-content: center; padding: 18px; box-sizing: border-box; backdrop-filter: blur(2px); }
            .stiae-overlay.stiae-review-layer { z-index: 45200; }
            .stiae-overlay.stiae-sub-layer { z-index: 45300; }
            .stiae-overlay.stiae-confirm-layer { z-index: 45400; }
            .stiae-confirm-modal { position: relative; width: min(430px, calc(100vw - 36px)); background: var(--stiae-bg); color: var(--stiae-fg); border: 1px solid var(--stiae-border); border-radius: 10px; box-shadow: 0 18px 60px rgba(0,0,0,.55); display: flex; flex-direction: column; overflow: hidden; }
            /* pre-line so a confirmation can use blank lines to separate "what is about
               to happen" from "what it costs you". Messages without newlines are unchanged. */
            .stiae-confirm-text { padding: 18px 18px 4px; line-height: 1.6; overflow-wrap: anywhere; white-space: pre-line; }
            /* ⚠️ min-width is wrapped in min() for a reason: the editor now carries a
               320px sidebar beside the text, so the floor below which it stops being
               usable went up — but a flat 780px would push the window wider than a
               narrow desktop viewport, since max-width cannot win against min-width. */
            .stiae-modal { position: fixed; display: flex; flex-direction: column; min-width: min(780px, calc(100vw - 24px)); min-height: 420px; max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); overflow: hidden; resize: both; background: var(--stiae-bg); color: var(--stiae-fg); border: 1px solid var(--stiae-border); border-radius: 10px; box-shadow: 0 18px 60px rgba(0,0,0,.55); }
            .stiae-review-modal { position: relative; width: min(1180px, calc(100vw - 36px)); height: min(820px, calc(100vh - 36px)); resize: both; }
            .stiae-settings-modal { position: relative; width: min(900px, calc(100vw - 36px)); max-height: min(850px, calc(100vh - 36px)); background: var(--stiae-bg); border: 1px solid var(--stiae-border); border-radius: 10px; box-shadow: 0 18px 60px rgba(0,0,0,.55); display: flex; flex-direction: column; overflow: hidden; }
            .stiae-header { flex: 0 0 auto; display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-bottom: 1px solid var(--stiae-border); cursor: move; user-select: none; }
            .stiae-header strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .stiae-close { border: 0; background: transparent; color: inherit; font-size: 22px; cursor: pointer; padding: 0 5px; opacity: .8; }
            .stiae-close:hover { opacity: 1; }
            .stiae-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; padding: 9px 12px; border-bottom: 1px solid var(--stiae-border); overflow-x: auto; }
            .stiae-toolbar-spacer { flex: 1; }
            /* ⚠️ box-sizing matters here, and not for tidiness. This class lands on both
               <button> and <summary>: a button is border-box by default, a summary is
               content-box, so the same min-height made every dropdown 14px taller than
               the plain buttons beside it. The ⋯ menu has been the odd one out since
               0.6.1 for this reason; the group folders made it obvious. */
            .stiae-button { display: inline-flex !important; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; min-height: 34px; box-sizing: border-box; }
            .stiae-icon-button span { display: none; }
            /* A folder is a container, not another action, so it reads one notch quieter
               than the commands beside it — same size, same shape, just the icon carrying
               the theme accent and the whole button slightly held back until you reach
               for it. Making it *bigger* was the first attempt and it looked bolted on. */
            .stiae-folder { opacity: .82; }
            .stiae-folder:hover, details[open] > .stiae-folder { opacity: 1; }
            .stiae-folder i { color: var(--stiae-accent); }
            .stiae-more { position: relative; }
            .stiae-more > summary { list-style: none; cursor: pointer; }
            .stiae-more > summary::-webkit-details-marker { display: none; }
            /* ⚠️ fixed, not absolute — and that is not a style preference.
               .stiae-toolbar carries overflow-x: auto so the buttons can scroll sideways
               on a phone. Per spec, an overflow of auto on one axis turns "visible" on the
               other axis into auto too, which makes the toolbar a scroll container that
               CLIPS anything positioned out of it. An absolutely positioned menu therefore
               lost everything below the toolbar's bottom edge: measured 222px tall, 4px
               visible. Fixed positioning escapes the clip; positionToolbarMenu() supplies
               the coordinates, since fixed no longer follows the button on its own. */
            .stiae-menu { position: fixed; z-index: 45100; min-width: 190px; max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding: 7px; background: var(--stiae-bg); border: 1px solid var(--stiae-border); border-radius: 7px; box-shadow: 0 10px 30px rgba(0,0,0,.4); }
            .stiae-menu .stiae-button { width: 100%; justify-content: flex-start; }
            .stiae-mobile-menu-item { display: none !important; }
            .stiae-scope { flex: 0 0 auto; padding: 7px 13px; color: var(--stiae-muted); border-bottom: 1px solid var(--stiae-border); font-size: .9em; }
            .stiae-scope.is-selection { color: var(--SmartThemeEmColor, #f1d37a); }
            /* The text and the settings that describe it sit side by side from 0.8.0.
               Before that everything was one column, and expanding the reference section
               ate up to 46vh of the textarea — the reason this layout exists. */
            .stiae-main { flex: 1 1 auto; min-height: 0; display: flex; align-items: stretch; }
            .stiae-workspace { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
            .stiae-side { flex: 0 0 320px; min-width: 0; display: flex; flex-direction: column; border-left: 1px solid var(--stiae-border); }
            /* ⚠️ The one and only scrolling region in the sidebar. Nothing inside the
               three sections may carry its own max-height + overflow: two scrollers
               nested like that fight over the same wheel gesture, which is exactly what
               moving the world info picker into its own window fixed in 0.7.0. A long
               list simply makes this column longer. */
            .stiae-side-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
            .stiae-side-foot { flex: 0 0 auto; padding: 9px 11px; border-top: 1px solid var(--stiae-border); }
            .stiae-side-foot .stiae-button { width: 100%; }
            .stiae-side-section { border-bottom: 1px solid var(--stiae-border); }
            .stiae-side-summary { display: flex; align-items: baseline; gap: 6px; cursor: pointer; padding: 9px 11px; font-size: .92em; font-weight: 700; list-style: none; }
            .stiae-side-summary::-webkit-details-marker { display: none; }
            /* A caret drawn by us, because a summary set to display:flex loses the
               browser's own marker in Chrome — and a section that cannot be seen to be
               foldable will not get folded. */
            .stiae-side-summary::before { content: '▸'; flex: 0 0 auto; color: var(--stiae-muted); font-weight: 400; }
            details[open] > .stiae-side-summary::before { content: '▾'; }
            .stiae-side-count { margin-left: auto; color: var(--stiae-muted); font-size: .82em; font-weight: 400; text-align: right; overflow-wrap: anywhere; }
            .stiae-side-body { display: flex; flex-direction: column; gap: 7px; padding: 0 11px 11px; }
            /* A row is a lookup: press it and the whole floor or entry opens in a window
               of its own. The ✕ on a world info row is a second button beside it rather
               than inside it — a button within a button is not valid, and clicking to
               remove would also trigger the lookup. */
            .stiae-side-row { display: flex; align-items: stretch; border: 1px solid var(--stiae-border); border-radius: 6px; background: rgba(0,0,0,.14); }
            .stiae-side-row:hover { border-color: var(--stiae-accent); }
            .stiae-side-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 6px 7px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
            .stiae-side-row-x { flex: 0 0 auto; padding: 0 8px; border: 0; background: transparent; color: var(--stiae-muted); cursor: pointer; font: inherit; }
            .stiae-side-row-x:hover { color: #ff9b9b; }
            .stiae-side-row-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
            .stiae-side-row-id { flex: 0 0 auto; font-weight: 700; color: var(--stiae-accent); }
            .stiae-side-row-meta { color: var(--stiae-muted); font-size: .82em; overflow-wrap: anywhere; }
            /* Two lines of the text itself, then it stops. One line was not enough to
               recognise a scene by; unbounded turns the sidebar into the transcript. */
            .stiae-side-row-snippet { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: .85em; line-height: 1.45; opacity: .9; overflow-wrap: anywhere; }
            .stiae-side-row-dim { opacity: .55; }
            .stiae-side-static { padding: 6px 7px; border: 1px dashed var(--stiae-border); border-radius: 6px; }
            .stiae-reference-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
            .stiae-reference-input { flex: 1 1 190px; min-width: 0; box-sizing: border-box; padding: 7px; border: 1px solid var(--stiae-border); border-radius: 5px; background: rgba(0,0,0,.18); color: var(--stiae-fg); font-family: inherit; font-size: 1em; }
            .stiae-reference-notes { display: flex; flex-direction: column; gap: 4px; }
            .stiae-reference-bad { color: #ffb0b0; font-size: .88em; }
            .stiae-reference-list { display: flex; flex-direction: column; gap: 5px; }
            .stiae-ref-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .92; }
            .stiae-wb-modal { width: min(760px, calc(100vw - 36px)); height: min(760px, calc(100vh - 36px)); max-height: min(760px, calc(100vh - 36px)); resize: both; }
            /* Only the entry list scrolls. The search box and the book dropdown stay put
               while you work through a book — that pinning is the point of the dialog, and
               it is why the list no longer needs a nested scroller of its own. */
            .stiae-wb-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 7px; padding: 12px 14px; }
            .stiae-wb-selected { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 7px; flex-wrap: wrap; max-height: 26%; overflow-y: auto; }
            .stiae-wb-groups { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; }
            .stiae-wb-picker { flex: 1 1 100%; min-width: 0; box-sizing: border-box; padding: 7px; border: 1px solid var(--stiae-border); border-radius: 5px; background: rgba(0,0,0,.18); color: var(--stiae-fg); font-family: inherit; font-size: 1em; }
            .stiae-wb-booktitle { margin-top: 7px; color: var(--stiae-muted); font-size: .88em; }
            .stiae-wb-chips { display: flex; flex-wrap: wrap; gap: 5px; width: 100%; }
            .stiae-wb-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; padding: 3px 4px 3px 8px; border: 1px solid var(--stiae-border); border-radius: 11px; font-size: .85em; overflow-wrap: anywhere; }
            .stiae-wb-chip-x { flex: 0 0 auto; padding: 0 5px; border: 0; border-radius: 50%; background: transparent; color: var(--stiae-muted); cursor: pointer; font: inherit; line-height: 1.6; }
            .stiae-wb-chip-x:hover { color: #ff9b9b; }
            /* No max-height and no scroller of its own: .stiae-wb-groups above is the one
               scrolling region now. WORLDBOOK_ROW_LIMIT still bounds how many rows exist. */
            .stiae-wb-list { display: flex; flex-direction: column; gap: 4px; padding: 4px 0 4px 9px; }
            .stiae-wb-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px; border: 1px solid var(--stiae-border); border-radius: 6px; cursor: pointer; font-size: .88em; }
            .stiae-wb-row input { width: auto; margin-top: 3px; }
            .stiae-wb-row > div { flex: 1 1 auto; min-width: 0; }
            /* The two read-only windows the sidebar opens: one floor / one world info
               entry, and the whole request. Both are built on .stiae-settings-modal so the
               phone rule that takes dialogs full screen already covers them. */
            .stiae-text-modal { width: min(720px, calc(100vw - 36px)); height: min(700px, calc(100vh - 36px)); max-height: min(700px, calc(100vh - 36px)); resize: both; }
            .stiae-text-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; }
            .stiae-text-tabs { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
            .stiae-tab-on { border-color: var(--SmartThemeQuoteColor, #7aa2d8) !important; }
            .stiae-text-pre { flex: 1 1 auto; min-height: 0; overflow: auto; margin: 0; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(0,0,0,.22); border: 1px solid var(--stiae-border); border-radius: 6px; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
            .stiae-preview-modal { width: min(900px, calc(100vw - 36px)); height: min(820px, calc(100vh - 36px)); max-height: min(820px, calc(100vh - 36px)); resize: both; }
            /* One scroller again: the message bodies below grow, the dialog scrolls. */
            .stiae-preview-body { flex: 1 1 auto; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; }
            .stiae-preview-pick { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
            .stiae-preview-rows { display: flex; flex-direction: column; gap: 8px; }
            .stiae-preview-pre { margin: 0; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(0,0,0,.22); border: 1px solid var(--stiae-border); border-radius: 6px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
            .stiae-request-preview { margin-bottom: 9px; border: 1px solid var(--stiae-border); border-radius: 7px; padding: 8px; }
            .stiae-request-preview > summary { cursor: pointer; color: var(--stiae-muted); }
            .stiae-request-role { margin: 8px 0 3px; font-weight: 700; font-size: .88em; color: var(--stiae-muted); }
            .stiae-request-body { max-height: 300px; overflow: auto; margin: 0; padding: 9px; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(0,0,0,.22); border: 1px solid var(--stiae-border); border-radius: 6px; font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
            /* ⚠️ No max-height and no scroller. In the settings dialog this list had one;
               in the sidebar a second scroller would compete with .stiae-side-scroll for
               the same wheel gesture. */
            .stiae-regex-list { display: flex; flex-direction: column; gap: 5px; }
            .stiae-regex-row { display: flex; align-items: flex-start; gap: 8px; padding: 7px; border: 1px solid var(--stiae-border); border-radius: 6px; cursor: pointer; font-size: .88em; }
            .stiae-regex-row input { width: auto; margin-top: 3px; }
            .stiae-regex-override { margin-top: 3px; color: #ffc98a; font-size: .84em; line-height: 1.45; }
            .stiae-editor-body { flex: 1 1 auto; min-height: 0; padding: 12px; display: flex; }
            .stiae-editor-text { width: 100%; height: 100%; min-height: 230px; resize: none; box-sizing: border-box; padding: 12px; border: 1px solid var(--stiae-border); border-radius: 7px; background: rgba(0,0,0,.18); color: var(--stiae-fg); font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; }
            .stiae-footer { flex: 0 0 auto; display: flex; justify-content: flex-end; gap: 8px; padding: 10px 13px; border-top: 1px solid var(--stiae-border); }
            .stiae-primary { border-color: var(--SmartThemeQuoteColor, #7aa2d8) !important; }
            .stiae-danger { color: #ff9b9b !important; }
            .stiae-review-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 12px; }
            .stiae-status { margin-bottom: 9px; color: var(--stiae-muted); }
            .stiae-warning { margin: 0 0 9px; padding: 8px 10px; border: 1px solid #c79036; border-radius: 6px; color: #ffd38a; background: rgba(150,95,10,.18); }
            .stiae-stream { min-height: 260px; margin: 0; padding: 12px; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(0,0,0,.22); border: 1px solid var(--stiae-border); border-radius: 7px; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
            .stiae-diff-tabs { display: none; gap: 6px; margin-bottom: 8px; }
            .stiae-diff-title { position: sticky; top: 0; z-index: 1; padding: 7px 10px; font-weight: 700; background: var(--stiae-bg); border-bottom: 1px solid var(--stiae-border); font-family: var(--mainFontFamily, system-ui), sans-serif; }
            .stiae-word-removed { background: rgba(235,70,70,.42); text-decoration: line-through; }
            .stiae-word-added { background: rgba(65,205,105,.38); }
            .stiae-diff-empty { opacity: .35; }
            .stiae-diff-grid { --stiae-gate-width: 46px; display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1fr); border: 1px solid var(--stiae-border); border-radius: 7px; overflow: hidden; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
            .stiae-diff-grid.stiae-has-gate { grid-template-columns: var(--stiae-gate-width) minmax(0,1fr) minmax(0,1fr); }
            .stiae-diff-gate { display: flex; align-items: flex-start; justify-content: center; padding-top: 2px; }
            .stiae-diff-title.stiae-diff-gate { align-items: center; padding: 7px 2px; font-size: .82em; white-space: nowrap; color: var(--stiae-muted); }
            .stiae-diff-checkbox { width: 17px; height: 17px; margin: 0; accent-color: var(--SmartThemeQuoteColor, #7aa2d8); cursor: pointer; }
            .stiae-diff-cell { min-width: 0; min-height: 1.55em; padding: 1px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
            .stiae-diff-cell.removed { background: rgba(220,70,70,.19); }
            .stiae-diff-cell.added { background: rgba(70,190,105,.18); }
            .stiae-diff-off { opacity: .38; }
            .stiae-full-preview { margin-top: 12px; border: 1px solid var(--stiae-border); border-radius: 7px; padding: 8px; }
            .stiae-full-preview > summary { cursor: pointer; color: var(--stiae-muted); }
            .stiae-full-preview .stiae-diff-grid { margin-top: 8px; }
            .stiae-settings-body { overflow: auto; padding: 14px; }
            .stiae-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 13px; }
            .stiae-field > label { font-weight: 700; }
            /* Section headings. The settings dialog is one long scroll, so a heading has
               to be findable while skimming: bigger than the body text, full brightness
               (help text is the faded one), and carrying the rule that separates it from
               the section above. That rule is why there is no separate divider element —
               having both produced two lines with a gap between them. */
            .stiae-field-label { margin: 30px 0 12px; padding-top: 20px; border-top: 1px solid var(--stiae-border); color: var(--stiae-fg); font-size: 1.12em; font-weight: 700; }
            .stiae-tabpane > .stiae-field-label:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
            /* ⚠️ Tabs rather than folding sections. Two panes are drag-to-reorder lists,
               and a fold above one of them moves every landing spot mid-drag — a failure
               this project has already shipped once. Tabs also keep the one-scrolling-
               area rule: only one pane is in the flow at a time, so .stiae-settings-body
               stays the single scroller. */
            .stiae-tabbar { display: flex; gap: 6px; padding: 10px 14px 0; border-bottom: 1px solid var(--stiae-border); overflow-x: auto; flex: 0 0 auto; }
            .stiae-tabbar .stiae-button { white-space: nowrap; }
            .stiae-changelog { margin-top: 6px; }
            .stiae-changelog-version { margin: 14px 0 4px; color: var(--stiae-fg); font-weight: 700; }
            .stiae-changelog-notes { margin: 0; padding-left: 20px; color: var(--stiae-muted); font-size: .88em; line-height: 1.55; }
            .stiae-changelog-notes li { margin: 3px 0; }
            .stiae-warn { color: #ffb0b0; }
            /* Counts and other asides that ride along with a heading without competing. */
            .stiae-label-note { margin-left: 9px; color: var(--stiae-muted); font-size: .8em; font-weight: 400; }
            .stiae-button-row { margin: 12px 0 9px; }
            .stiae-settings-body > .stiae-checkbox { margin: 11px 0; }
            .stiae-help { color: var(--stiae-muted); font-size: .88em; line-height: 1.5; }
            .stiae-help + .stiae-help { margin-top: 7px; }
            /* The browser default link blue belongs to no SillyTavern theme. */
            .stiae-help a { color: var(--stiae-accent); }
            /* Disabled has to look disabled: the up/down arrows at a group boundary and
               the update button with nothing to install are both disabled buttons that
               otherwise look exactly like working ones. */
            .stiae-button:disabled { opacity: .42; cursor: default; }
            .stiae-field input, .stiae-field select, .stiae-field textarea { width: 100%; box-sizing: border-box; padding: 7px; border: 1px solid var(--stiae-border); border-radius: 5px; background: rgba(0,0,0,.18); color: var(--stiae-fg); font-family: inherit; font-size: 1em; }
            .stiae-field input::placeholder, .stiae-field textarea::placeholder { color: var(--stiae-muted); opacity: .75; }
            .stiae-field select option { background: var(--stiae-bg); color: var(--stiae-fg); }
            .stiae-field textarea { min-height: 92px; resize: vertical; }
            .stiae-field textarea.stiae-payload-text { min-height: 170px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em; }
            .stiae-command-list { display: flex; flex-direction: column; gap: 7px; }
            /* A group is a box around its commands. A heading with a rule under it was not
               enough once the 未分組 heading went away: with nothing marking where a group
               ends, the list read as one flat run and there was no way to tell a grouped
               command from a loose one. */
            .stiae-group-box { display: flex; flex-direction: column; gap: 7px; padding: 8px 9px 9px; border: 1px solid var(--stiae-border); border-radius: 8px; background: rgba(127,127,127,.06); }
            /* ⚠️ Fixed height, always. These gaps used to be display:none and appear on
               dragstart — which pushed the list open the instant you pressed down: the
               row being dragged jumped 38px and the list grew 113px, so every drop target
               was somewhere other than where it had been aimed at. Dragging became
               impossible. Nothing here may change the layout; only the colours change. */
            .stiae-loose-zone { height: 14px; margin: -3px 0; box-sizing: border-box; overflow: hidden; border: 1px dashed transparent; border-radius: 6px; color: transparent; font-size: .72em; line-height: 12px; text-align: center; }
            .stiae-command-list.stiae-dragging-command .stiae-loose-zone { border-color: var(--stiae-border); color: var(--stiae-muted); }
            .stiae-loose-zone.stiae-drop-target { border-color: var(--stiae-accent); background: rgba(127,127,127,.14); color: var(--stiae-fg); outline: none; }
            .stiae-command-group { display: flex; align-items: center; gap: 4px; padding-bottom: 6px; border-bottom: 1px solid var(--stiae-border); color: var(--stiae-muted); font-size: .88em; font-weight: 700; }
            .stiae-group-spacer { flex: 1; }
            .stiae-group-action { min-height: 24px !important; padding: 1px 6px !important; opacity: .75; }
            .stiae-group-action:hover { opacity: 1; }
            /* Four columns: handle, icon, name, actions. A row without a handle must say
               so — see .stiae-command-row-plain — or its three children fill the first
               three columns and the buttons end up in the middle. */
            .stiae-command-row { display: grid; grid-template-columns: auto auto minmax(0,1fr) auto; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--stiae-border); border-radius: 7px; }
            .stiae-command-row-plain { grid-template-columns: auto minmax(0,1fr) auto; }
            /* Prompt cards come in three tiers of "may I touch this", and until they were
               told apart by colour the only way to find out was to read every row.
               The signal is a bar down the left edge, read as: theme colour = yours,
               grey = the tool's, grey on a filled row = nailed down.

               ⚠️ All three are set once when the row is built and never toggled during a
               drag, so the 3px border cannot shift the layout out from under the pointer
               (see .stiae-loose-zone for why that matters). Everything here is derived
               from the theme's own variables — a hardcoded palette fights whichever
               SillyTavern theme the user picked. */
            /* ⚠️ Two signals, not one: the bar's colour AND how filled the row is. The bar
               alone is not enough — --stiae-accent is whatever the user's theme sets as
               its quote colour, and on a desaturated theme it lands close enough to
               --stiae-muted that 使用者卡 and 系統卡 stop being telling apart. The
               background makes a ramp that survives any accent: empty → faint → filled. */
            .stiae-card-user { border-left: 3px solid var(--stiae-accent); }
            .stiae-card-user > i { color: var(--stiae-accent); }
            .stiae-card-system { border-left: 3px solid var(--stiae-muted); background: rgba(127,127,127,.07); }
            .stiae-card-system > i { color: var(--stiae-muted); }
            .stiae-card-locked { border-left: 3px solid var(--stiae-border); background: rgba(127,127,127,.18); }
            .stiae-card-locked > i, .stiae-card-locked strong { color: var(--stiae-muted); }
            /* A switched-off card is still yours — it keeps its colour and loses its
               presence, so "off" never reads as "locked". */
            .stiae-card-off { opacity: .5; }
            /* Reordering is by dragging on desktop and by arrows on touch — never both at
               once, because two ways to do the same thing in one row is just clutter. */
            .stiae-move-button { display: none !important; }
            .stiae-drag-grip { color: var(--stiae-muted); cursor: grab; opacity: .7; }
            .stiae-command-row:active .stiae-drag-grip { cursor: grabbing; }
            .stiae-dragging { opacity: .45; }
            /* Two different meanings, two different signals: a line on one edge is a
               position (it will land against that edge), a dashed outline is a container
               (it will land inside). */
            .stiae-drop-target { outline: 2px dashed var(--stiae-accent); outline-offset: 2px; }
            .stiae-drop-before { box-shadow: inset 0 3px 0 var(--stiae-accent); }
            .stiae-drop-after { box-shadow: inset 0 -3px 0 var(--stiae-accent); }
            .stiae-command-row-actions { display: flex; gap: 4px; }
            .stiae-command-row-actions button { min-width: 34px; }
            .stiae-inline-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
            .stiae-checkbox { display: flex; align-items: center; gap: 7px; }
            .stiae-checkbox input { width: auto; }
            .stiae-hidden { display: none !important; }
            /* The only outward sign of an available update: a dot on the settings button.
               An update is never urgent enough to interrupt what is being edited. */
            .stiae-has-update { position: relative; }
            .stiae-has-update::after { content: ''; position: absolute; top: 2px; right: 2px; width: 8px; height: 8px; border-radius: 50%; background: var(--SmartThemeEmColor, #f1d37a); }
            .stiae-wand { color: var(--SmartThemeEmColor, inherit); }
            @media (max-width: 760px) {
                .stiae-overlay { padding: 0; }
                .stiae-modal, .stiae-review-modal, .stiae-settings-modal { inset: 0 !important; width: 100vw !important; height: 100dvh !important; max-width: none; max-height: none; min-width: 0; min-height: 0; border-radius: 0; resize: none; }
                /* The confirmation stays a small box even here — going full screen
                   would hide which dialog asked the question. */
                .stiae-overlay.stiae-confirm-layer { padding: 16px; }
                .stiae-header { cursor: default; }
                .stiae-desktop-pin { display: none !important; }
                .stiae-mobile-menu-item { display: inline-flex !important; }
                .stiae-diff-tabs { display: flex; }
                /* HTML5 drag-and-drop does not fire on touch, so the handle would be a
                   button that does nothing — the arrows take over here instead. */
                .stiae-drag-grip { display: none; }
                .stiae-move-button { display: inline-flex !important; }
                .stiae-command-row { grid-template-columns: auto minmax(0,1fr) auto; }
                /* One text column at a time, chosen by the tabs. The gutter stays,
                   so a change can still be declined without switching sides. */
                .stiae-diff-grid { grid-template-columns: minmax(0,1fr); }
                .stiae-diff-grid.stiae-has-gate { grid-template-columns: var(--stiae-gate-width) minmax(0,1fr); }
                .stiae-diff-grid[data-active="proposed"] .original,
                .stiae-diff-grid[data-active="original"] .proposed { display: none; }
                .stiae-inline-fields { grid-template-columns: 1fr; }
                .stiae-button span { display: inline; }
                .stiae-toolbar { flex-wrap: nowrap; }
                /* The phone keeps the 0.7.2 shape: one column, the settings stacked above
                   the text and folded away by default (openEditor sets that), bounded by
                   the same 52vh the reference section used to have. A 320px column beside
                   a 375px screen would leave nothing to edit in. */
                .stiae-main { flex-direction: column; }
                .stiae-side { order: -1; flex: 0 0 auto; max-height: 52vh; border-left: 0; border-bottom: 1px solid var(--stiae-border); }
                .stiae-reference-input { flex: 1 1 100%; }
                .stiae-ref-text { flex: 1 1 100%; white-space: normal; }
            }
        `;
        hostDocument.head.append(style);
    }

    // ══════ 宿主 API 包裝：樓層、正則、世界書 ══════

    function waitForDocument() {
        return new Promise(resolve => {
            if (hostDocument.body && hostDocument.querySelector('#chat')) return resolve();
            const started = Date.now();
            const timer = hostWindow.setInterval(() => {
                if (hostDocument.body && hostDocument.querySelector('#chat')) {
                    hostWindow.clearInterval(timer);
                    resolve();
                } else if (Date.now() - started > 15000) {
                    hostWindow.clearInterval(timer);
                    resolve();
                }
            }, 200);
        });
    }

    function getMessage(messageId, includeSwipes = false) {
        return tavern.getChatMessages(Number(messageId), { include_swipes: includeSwipes })?.[0] || null;
    }

    function getChatMaxMessageId() {
        try {
            const last = tavern.getChatMessages('-1')?.[0];
            const id = Number(last?.message_id);
            return Number.isInteger(id) ? id : null;
        } catch (error) {
            console.warn('[ST Inline AI Editor] Could not determine the chat length.', error);
            return null;
        }
    }

    // One host call per contiguous run instead of one per floor. The comma form the
    // editor accepts is *not* passed through: the host answers it with an empty array
    // and no error, which would hand the user a silently empty reference.
    function fetchFloors(ids) {
        const found = new Map();
        for (const range of idsToRanges(ids)) {
            const query = range.from === range.to ? String(range.from) : `${range.from}-${range.to}`;
            try {
                for (const message of tavern.getChatMessages(query) || []) {
                    found.set(Number(message.message_id), message);
                }
            } catch (error) {
                console.warn(`[ST Inline AI Editor] Could not read floors ${query}.`, error);
            }
        }
        return ids.map(id => found.get(id)).filter(Boolean);
    }

    // Read fresh every time rather than cached: character-scoped rules change with the
    // character card, and a stale list would quietly apply the wrong set. Returns null
    // when the host could not be asked at all, which the UI reports rather than
    // silently treating as "no rules".
    async function readTavernRegexes() {
        try {
            // ⚠️ The newer `{ type: 'all' }` option throws on this host; the older
            // scope/enable_state pair is the working form (verified on a live install).
            const rules = await tavern.getTavernRegexes({ scope: 'all', enable_state: 'all' });
            return Array.isArray(rules) ? rules : [];
        } catch (error) {
            console.warn('[ST Inline AI Editor] Could not list SillyTavern regex rules.', error);
            return null;
        }
    }

    // Everything below reads world info and nothing else. This tool never calls
    // SillyTavern's own recall engine (getWorldInfoPrompt) and never writes to a book.
    //
    // ⚠️ Not an oversight — see ADR-0004. A recall would match normal chat exactly, but
    // `isDryRun: true` does not gate three of its side effects, and one of them cannot
    // be undone from here: the scan clears the static map holding entries other
    // extensions queued for the user's *next* real generation. Running a recall inside
    // this editor would silently change the next normal reply.
    function worldbookApiAvailable() {
        return typeof tavern.getWorldbook === 'function' && typeof tavern.getWorldbookNames === 'function';
    }

    // A book can be reachable through more than one route; the first route found wins so
    // the label stays stable. Each getter is guarded separately because one of them
    // failing (no character open, for instance) must not cost the other two.
    function collectActiveWorldbooks() {
        const found = new Map();
        const add = (name, origin) => {
            const value = String(name || '').trim();
            if (value && !found.has(value)) found.set(value, origin);
        };
        try {
            for (const name of tavern.getGlobalWorldbookNames?.() || []) add(name, '全域啟用');
        } catch (error) {
            console.warn('[ST Inline AI Editor] Could not list global world info books.', error);
        }
        try {
            const bound = tavern.getCharWorldbookNames?.('current') || {};
            add(bound.primary, '角色卡');
            for (const name of bound.additional || []) add(name, '角色卡');
        } catch (error) {
            console.warn('[ST Inline AI Editor] Could not list character world info books.', error);
        }
        try {
            add(tavern.getChatWorldbookName?.('current'), '聊天');
        } catch (error) {
            console.warn('[ST Inline AI Editor] Could not read the chat world info book.', error);
        }
        return found;
    }

    // A plain read with no side effects, unlike the world info recall engine this project
    // deliberately does not call (ADR-0004). Returns '' when it cannot be determined,
    // which the callers treat as "do not restore anything".
    function currentChatId() {
        try {
            return String(getContext()?.getCurrentChatId?.() ?? '');
        } catch (error) {
            console.warn('[ST Inline AI Editor] Could not determine the current chat id.', error);
            return '';
        }
    }

    function worldbookOrigin(session, name) {
        return session.worldbookOrigins?.get(name) || '未啟用';
    }

    // Books are cached by name in one map rather than kept as two separate lists, because
    // a remembered pick can name a book this chat does not have active — that book has to
    // be loadable on its own, before and independently of either group.
    //
    // A book that cannot be read is still recorded, carrying its error: an unreadable book
    // and an empty one look identical otherwise.
    async function loadWorldbooks(session, names) {
        const wanted = [...new Set([...names].map(String).filter(Boolean))]
            .filter(name => !session.worldbookBooks.has(name));
        if (!wanted.length) return;
        const groups = await Promise.all(wanted.map(async name => {
            try {
                const raw = await tavern.getWorldbook(name);
                const entries = (Array.isArray(raw) ? raw : [])
                    .map(entry => normalizeWorldbookEntry(entry, name))
                    .filter(Boolean);
                return { book: name, entries, error: null };
            } catch (error) {
                console.warn(`[ST Inline AI Editor] Could not read world info book "${name}".`, error);
                return { book: name, entries: [], error: String(error?.message || error) };
            }
        }));
        if (state.activeEditor !== session) return;
        for (const group of groups) session.worldbookBooks.set(group.book, group);
    }

    // Active books first, then the rest — the same order the dropdown shows, so search
    // results and the picker never disagree about where a book sits.
    function worldbookBookGroups(session) {
        return [...session.worldbookOrigins.keys(), ...(session.worldbookOtherNames || [])]
            .map(name => session.worldbookBooks.get(name))
            .filter(Boolean)
            .map(group => ({ ...group, origin: worldbookOrigin(session, group.book) }));
    }

    // Names only — no entries are read here. This is what lets the dropdown be built the
    // moment the section opens while the books themselves stay unread.
    function collectOtherWorldbookNames(origins) {
        try {
            return (tavern.getWorldbookNames() || []).map(String).filter(name => name && !origins.has(name));
        } catch (error) {
            console.warn('[ST Inline AI Editor] Could not list world info books.', error);
            return [];
        }
    }

    function allLoadedWorldbookEntries(session) {
        return [...session.worldbookBooks.values()].flatMap(group => group.entries);
    }

    // Selection order follows the loaded catalogue rather than the order boxes were
    // ticked: the request should read the same way twice for the same set of entries.
    //
    // `missing` carries the stored { book, uid } rather than the joined key so the notice
    // can name what is gone. It is a real case now that picks are remembered: a character
    // card can be swapped out from under them.
    function selectedWorldbookEntries(session) {
        const wanted = session.worldbookSelection;
        if (!wanted?.size) return { entries: [], missing: [] };
        const entries = allLoadedWorldbookEntries(session).filter(entry => wanted.has(entry.key));
        const present = new Set(entries.map(entry => entry.key));
        const missing = [...wanted.entries()].filter(([key]) => !present.has(key)).map(([, ref]) => ref);
        return { entries, missing };
    }

    // Written through on every tick rather than batched at close: the editor can be closed
    // by a route that never reaches a save, and a pick that silently failed to stick is
    // the exact annoyance this feature exists to remove.
    function persistWorldbookSelection(session) {
        state.settings.worldbookSelection = [...session.worldbookSelection.values()]
            .map(ref => ({ book: ref.book, uid: ref.uid }));
        saveSettings();
    }

    // ⚠️ A floor number only means something inside its own chat. The id is stored beside
    // the text so that opening the editor in a different chat restores nothing at all,
    // rather than quietly attaching whatever scene happens to sit at those numbers.
    function persistReferenceInput(session) {
        const chatId = currentChatId();
        state.settings.referenceInput = session.referenceInput;
        state.settings.referenceChatId = session.referenceInput && chatId ? chatId : '';
        saveSettings();
    }

    function restoredReferenceInput() {
        const chatId = currentChatId();
        if (!chatId || state.settings.referenceChatId !== chatId) return '';
        return state.settings.referenceInput;
    }

    async function buildReference(session) {
        const maxId = getChatMaxMessageId();
        const parsed = parseFloorRange(session.referenceInput, {
            maxMessageId: maxId,
            excludeId: session.messageId,
        });
        const messages = fetchFloors(parsed.ids);
        const rules = await readTavernRegexes();
        const selectedIds = new Set(state.settings.regexRuleIds);
        const selected = (rules || []).filter(rule => selectedIds.has(String(rule.id)));
        const failedRules = new Set();
        const entries = messages.map(message => {
            // ⚠️ `message` only. The host attaches the whole `swipes` array by default,
            // and pulling that in would multiply a single floor several times over.
            const role = String(message.role || '');
            const raw = String(message.message ?? '');
            const applied = applyTavernRegexes(raw, selected, role);
            for (const name of applied.failed) failedRules.add(name);
            return {
                id: Number(message.message_id),
                name: String(message.name || ''),
                role,
                isHidden: Boolean(message.is_hidden),
                text: applied.text,
                // ⚠️ Kept here rather than re-read when the preview window opens. Reading
                // the floor again would show what it says *now*, which can differ from
                // what this reference material was built from — and the window would be
                // claiming to show the original of something it is not the original of.
                raw,
                appliedRules: applied.applied,
            };
        });
        // ⚠️ The third argument is the role, and 'world_info' is what SillyTavern calls
        // this kind of text. Leaving it out would mean "the caller does not know the
        // role", which skips the source check and runs every checked rule — including
        // ones written to strip things out of user input only.
        const picked = selectedWorldbookEntries(session);
        const worldbookEntries = picked.entries.map(entry => {
            const applied = applyTavernRegexes(entry.content, selected, 'world_info');
            for (const name of applied.failed) failedRules.add(name);
            // `raw` for the same reason as a floor's: the preview window has to be able to
            // show what the entry said before the rules ran, without going back to a
            // catalogue that may have been reloaded since.
            return { ...entry, content: applied.text, raw: entry.content, appliedRules: applied.applied };
        });

        const present = new Set(entries.map(entry => entry.id));
        return {
            parsed,
            entries,
            worldbook: {
                sent: worldbookEntries.filter(entry => entry.content.length),
                emptied: worldbookEntries.filter(entry => !entry.content.length),
                missing: picked.missing,
            },
            // A rule can legitimately consume a whole floor — "old floors keep only a
            // summary" is exactly that. Such a floor contributes nothing, so it stays
            // out of the block; but it was asked for by number, so it still has to be
            // accounted for on screen rather than quietly disappearing.
            sent: entries.filter(entry => entry.text.length),
            emptied: entries.filter(entry => !entry.text.length).map(entry => entry.id),
            block: buildReferenceBlock(entries, worldbookEntries),
            missing: parsed.ids.filter(id => !present.has(id)),
            maxId,
            rulesUnavailable: rules === null,
            failedRules: [...failedRules],
        };
    }

    // ══════ 編輯器介面：魔杖、視窗、參考資料 ══════

    function addWands() {
        if (state.destroyed) return;
        for (const messageElement of hostDocument.querySelectorAll('#chat .mes[mesid]')) {
            if (messageElement.querySelector('.stiae-wand')) continue;
            const messageId = Number(messageElement.getAttribute('mesid'));
            if (!Number.isInteger(messageId)) continue;
            const message = getMessage(messageId);
            if (!message || !['user', 'assistant'].includes(message.role)) continue;
            // Straight into `.mes_buttons`, NOT into the `.extraMesButtons` group it
            // used to live in: that group is `display: none` until the ⋯ is clicked,
            // which put this tool's only entry point two clicks away. The always-visible
            // stock buttons (checkpoint, edit) are direct children of `.mes_buttons`, and
            // `.mes_button` styling does not depend on the parent, so moving out keeps
            // the look. Verified against SillyTavern release `public/index.html`
            // (`#message_template`) and `public/style.css`.
            const actions = messageElement.querySelector('.mes_buttons');
            if (!actions) continue;
            const wand = createElement('div', 'mes_button stiae-wand fa-solid fa-wand-magic-sparkles');
            wand.title = 'AI 編輯這個樓層';
            wand.dataset.messageId = String(messageId);
            wand.setAttribute('role', 'button');
            wand.setAttribute('tabindex', '0');
            // Left of the pencil, so it reads as part of the editing group. Falls back
            // to the end of the row if a future layout drops `.mes_edit`.
            //
            // ⚠️ `:scope >` is load-bearing, not tidiness. A plain descendant query
            // would also match a `.mes_edit` that had been moved *into*
            // `.extraMesButtons`, and inserting before it would put the wand back
            // inside the collapsed group this version exists to escape — with the
            // append fallback never firing, so nothing would look wrong.
            const editButton = actions.querySelector(':scope > .mes_edit');
            if (editButton) editButton.before(wand);
            else actions.append(wand);
        }
    }

    function installWandObserver() {
        let queued = false;
        const schedule = () => {
            if (queued) return;
            queued = true;
            hostWindow.requestAnimationFrame(() => {
                queued = false;
                addWands();
            });
        };
        state.observer = new hostWindow.MutationObserver(schedule);
        state.observer.observe(hostDocument.body, { childList: true, subtree: true });
        addWands();
    }

    function captureEditorRect(modal) {
        if (!modal?.isConnected || hostWindow.innerWidth <= 760) return;
        const rect = modal.getBoundingClientRect();
        state.settings.editorRect = {
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            left: Math.round(rect.left),
            top: Math.round(rect.top),
        };
        saveSettings();
    }

    function placeEditorModal(modal) {
        const saved = state.settings.editorRect;
        // ⚠️ The floor is not cosmetic. A window saved by 0.7.x was sized for text alone;
        // reopening it in 0.8.0 puts a 320px sidebar inside the same width, and a 620px
        // window would leave a column of text too narrow to work in. Widened once on
        // open, then whatever the user drags it to is what gets remembered.
        const width = Math.min(Math.max(saved.width || 1180, 820), hostWindow.innerWidth - 24);
        const height = Math.min(saved.height || 720, hostWindow.innerHeight - 24);
        const left = saved.left == null ? (hostWindow.innerWidth - width) / 2 : Math.max(12, Math.min(saved.left, hostWindow.innerWidth - width - 12));
        const top = saved.top == null ? (hostWindow.innerHeight - height) / 2 : Math.max(12, Math.min(saved.top, hostWindow.innerHeight - height - 12));
        Object.assign(modal.style, { width: `${width}px`, height: `${height}px`, left: `${left}px`, top: `${top}px` });
    }

    function makeDraggable(modal, handle) {
        let drag = null;
        const down = event => {
            if (hostWindow.innerWidth <= 760 || event.target.closest('button')) return;
            // The ⋯ menu is fixed-positioned and placed once, when it opens. Dragging the
            // window out from under it would leave it hanging in mid-air.
            closeDetailsMenus(modal);
            const rect = modal.getBoundingClientRect();
            drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
            handle.setPointerCapture?.(event.pointerId);
        };
        const move = event => {
            if (!drag) return;
            const left = Math.max(0, Math.min(drag.left + event.clientX - drag.x, hostWindow.innerWidth - modal.offsetWidth));
            const top = Math.max(0, Math.min(drag.top + event.clientY - drag.y, hostWindow.innerHeight - modal.offsetHeight));
            modal.style.left = `${left}px`;
            modal.style.top = `${top}px`;
        };
        const up = () => { drag = null; };
        handle.addEventListener('pointerdown', down);
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
    }

    function scopeFromTextarea(textarea) {
        const fullText = textarea.value;
        const selectionStart = textarea.selectionStart ?? 0;
        const selectionEnd = textarea.selectionEnd ?? selectionStart;
        const hasSelection = selectionEnd > selectionStart;
        const start = hasSelection ? selectionStart : 0;
        const end = hasSelection ? selectionEnd : fullText.length;
        return {
            fullText,
            start,
            end,
            text: fullText.slice(start, end),
            hasSelection,
        };
    }

    function updateScopeNotice(session) {
        const scope = scopeFromTextarea(session.textarea);
        session.scopeNotice.classList.toggle('is-selection', scope.hasSelection);
        session.scopeNotice.textContent = scope.hasSelection
            ? `已選取 ${scope.end - scope.start} 個字元：AI 只能修改這個範圍。`
            : '未選取文字：AI 將處理整個樓層。';
    }

    // A main-thread fuse, the same kind as lcsOps' cellLimit: the echo list re-renders
    // on every keystroke, and a range covering hundreds of floors would rebuild
    // hundreds of rows inside the SillyTavern tab. The floors themselves are not
    // capped — only how many of them get drawn.
    const REFERENCE_LIST_LIMIT = 20;
    // Two clamped lines' worth. It was 40 while a row was a single ellipsised line in the
    // editor; a sidebar row has the height for enough text to recognise a scene by.
    const REFERENCE_SNIPPET_LENGTH = 90;
    const REFERENCE_DEBOUNCE_MS = 250;

    function referenceSnippet(text) {
        const value = String(text ?? '').replace(/\s+/g, ' ').trim();
        return value.length > REFERENCE_SNIPPET_LENGTH ? `${value.slice(0, REFERENCE_SNIPPET_LENGTH)}…` : value;
    }

    function roleLabelOf(role) {
        if (role === 'user') return '使用者';
        if (role === 'assistant') return 'AI';
        return role || '未知';
    }

    // Each section header states its own cost outright. In 0.7.2 one collapsed line did
    // this for all of it; the sidebar splits the setting into three, so the count splits
    // with it — a single total on one of the three headers would belong to none of them.
    //
    // The point is unchanged: what this request costs is readable without expanding
    // anything.
    function updateReferenceSummary(session) {
        if (!session.floorsCount) return;
        // Counts what actually goes out, not what was typed: a floor emptied by a regex
        // rule would otherwise be advertised as attached when nothing of it is sent.
        const sent = session.reference?.sent || [];
        if (!sent.length) {
            session.floorsCount.textContent = '未指定';
            return;
        }
        const size = sent.reduce((total, entry) => total + entry.text.length, 0);
        session.floorsCount.textContent = `${sent.length} 樓 · ${size.toLocaleString('en-US')} 字元`;
    }

    function updateRegexSummary(session) {
        if (!session.regexCount) return;
        const count = state.settings.regexRuleIds.length;
        session.regexCount.textContent = count ? `已勾選 ${count} 條` : '未勾選';
    }

    // Counts what actually goes out, for the same reason the outer line does: an entry a
    // regex rule emptied would otherwise be advertised as attached.
    //
    // ⚠️ Says 已附加, while the chip area in the dialog says 勾選中. The two numbers are
    // deliberately different — this one is what leaves for the model, that one is what is
    // ticked and loaded — and an entry emptied by a regex rule makes them disagree in
    // plain sight. Wording them alike made that read as a bug; the counts themselves are
    // both correct and neither may be changed to match the other.
    function updateWorldbookSummary(session) {
        if (!session.worldbookCount) return;
        const books = session.reference?.worldbook?.sent || [];
        session.worldbookCount.textContent = books.length
            ? `已附加 ${books.length} 條 · ${books.reduce((total, entry) => total + entry.content.length, 0).toLocaleString('en-US')} 字元`
            : '未附加';
    }

    function renderReferenceDetail(session) {
        const reference = session.reference;
        const parsed = reference?.parsed;
        const notes = session.referenceNotes;
        const list = session.referenceList;
        notes.replaceChildren();
        list.replaceChildren();

        const note = (className, text) => notes.append(createElement('div', className, text));

        if (parsed?.invalid.length) {
            note('stiae-reference-bad', `看不懂這幾段：${parsed.invalid.join('、')}。格式是「30, 42-46」。`);
        }
        if (parsed?.outOfRange.length) {
            const tail = reference.maxId === null ? '' : `目前最後一樓是第 ${reference.maxId} 樓。`;
            note('stiae-reference-bad', `超出聊天範圍：${parsed.outOfRange.join('、')}。${tail}`);
        }
        if (parsed?.truncated) {
            note('stiae-reference-bad', `一次最多帶 ${RANGE_EXPANSION_LIMIT} 樓，超出的部分沒有納入。`);
        }
        if (reference?.missing.length) {
            note('stiae-reference-bad', `讀不到這幾樓：第 ${formatFloorRanges(reference.missing)} 樓。`);
        }
        if (reference?.rulesUnavailable) {
            note('stiae-reference-bad', '讀不到 SillyTavern 的正則規則，這次沒有套用任何規則。');
        }
        if (reference?.failedRules.length) {
            note('stiae-reference-bad', `這幾條正則規則跑不起來，已跳過：${reference.failedRules.join('、')}。`);
        }
        if (reference?.emptied.length) {
            note('stiae-reference-bad', `第 ${formatFloorRanges(reference.emptied)} 樓套用正則後整段變成空的，不會送出。`);
        }
        if (reference?.entries.length && state.settings.regexRuleIds.length && !reference.rulesUnavailable) {
            note('stiae-help', `已套用 ${state.settings.regexRuleIds.length} 條正則規則（在下面的「正則規則」挑選）。`);
        }

        // Every floor the input resolved to shows up here, including the one that was
        // dropped. Dropping something without saying so is exactly what this project
        // does not do.
        const rows = [...(reference?.entries || [])];
        if (parsed?.excluded) rows.push({ id: session.messageId, excluded: true });
        rows.sort((a, b) => a.id - b.id);

        for (const row of rows.slice(0, REFERENCE_LIST_LIMIT)) {
            if (row.excluded) {
                const line = createElement('div', 'stiae-side-static stiae-side-row-dim');
                const head = createElement('div', 'stiae-side-row-head');
                head.append(createElement('strong', 'stiae-side-row-id', `#${row.id}`));
                head.append(createElement('span', 'stiae-side-row-meta', '已排除（這是你正在編輯的樓層）'));
                line.append(head);
                list.append(line);
                continue;
            }
            const marks = [row.name || '未知', roleLabelOf(row.role)];
            if (row.isHidden) marks.push('已隱藏');
            // Rules only run on the floors they were written for, so "why didn't
            // this one change" has to be answerable per floor, not just per rule.
            if (state.settings.regexRuleIds.length) marks.push(`正則 ${row.appliedRules ?? 0} 條`);
            if (!row.text.length) marks.push('正則後為空');
            list.append(sideRow({
                id: `#${row.id}`,
                meta: marks.join(' · '),
                snippet: referenceSnippet(row.text),
                dim: !row.text.length,
                openTitle: '看這一樓的完整內文',
                onOpen: () => openTextPreview({
                    title: `第 ${row.id} 樓 · ${roleLabelOf(row.role)}`,
                    subtitle: row.name || '',
                    sent: row.text,
                    raw: row.raw,
                }),
            }));
        }
        if (rows.length > REFERENCE_LIST_LIMIT) {
            list.append(createElement('div', 'stiae-help', `…另外還有 ${rows.length - REFERENCE_LIST_LIMIT} 樓，沒有列出來，但一樣會送出。`));
        }
        if (!rows.length && !notes.childElementCount) {
            list.append(createElement('div', 'stiae-help', '還沒指定任何樓層。'));
        }
    }

    // One row in the sidebar: press it and the thing it names opens in full. The ✕, when
    // there is one, is a sibling of that button rather than a child — a button inside a
    // button is invalid, and nesting would make removing an entry also open it.
    function sideRow({ id, meta, snippet, dim = false, openTitle = '', onOpen, onRemove = null }) {
        const wrapper = createElement('div', `stiae-side-row${dim ? ' stiae-side-row-dim' : ''}`);
        const main = createElement('button', 'stiae-side-row-main');
        main.type = 'button';
        if (openTitle) main.title = openTitle;
        const head = createElement('div', 'stiae-side-row-head');
        if (id) head.append(createElement('strong', 'stiae-side-row-id', id));
        head.append(createElement('span', 'stiae-side-row-meta', meta));
        main.append(head, createElement('div', 'stiae-side-row-snippet', snippet || '（空的）'));
        main.addEventListener('click', onOpen);
        wrapper.append(main);
        if (onRemove) {
            const drop = createElement('button', 'stiae-side-row-x', '✕');
            drop.type = 'button';
            drop.title = '取消這一條';
            drop.addEventListener('click', onRemove);
            wrapper.append(drop);
        }
        return wrapper;
    }

    // A read-only lookup: one floor, or one world info entry, in full — so that "which
    // scene was #42 again" is answerable without closing the editor and losing the draft.
    //
    // Shows what will actually be sent. When a regex rule changed the text there is a
    // second tab for the untouched original: the sent version is the honest default, and
    // the original is what makes a rule that ate half a floor visible instead of puzzling.
    //
    // ⚠️ Claims Escape through state.activeTextPreview. Without that flag
    // onDocumentKeydown would close the editor — and the draft with it — from under the
    // window being read. Same reason as the world info picker.
    function openTextPreview({ title, subtitle = '', sent, raw }) {
        if (state.activeTextPreview) return;
        const outgoing = String(sent ?? '');
        const original = String(raw ?? outgoing);
        const changed = original !== outgoing;

        const overlay = createElement('div', `${ROOT_CLASS} stiae-overlay stiae-sub-layer`);
        const modal = createElement('section', 'stiae-settings-modal stiae-text-modal');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        const header = createElement('header', 'stiae-header');
        header.append(createElement('strong', '', subtitle ? `${title} · ${subtitle}` : title));
        const close = createElement('button', 'stiae-close', '×');
        close.type = 'button';
        close.title = '關閉';
        header.append(close);

        const body = createElement('div', 'stiae-text-body');
        const tabs = createElement('div', 'stiae-text-tabs');
        const pre = createElement('pre', 'stiae-text-pre');
        const sentTab = button('會送出的內容', 'fa-paper-plane', 'stiae-tab-on');
        const rawTab = button('原始內容', 'fa-file-lines');
        const size = createElement('div', 'stiae-help');

        const show = which => {
            const text = which === 'raw' ? original : outgoing;
            pre.textContent = text || '（空的）';
            sentTab.classList.toggle('stiae-tab-on', which !== 'raw');
            rawTab.classList.toggle('stiae-tab-on', which === 'raw');
            size.textContent = which === 'raw'
                ? `這是套用正則規則之前的原文 · ${original.length.toLocaleString('en-US')} 字元`
                : `這就是會附給 AI 的文字 · ${outgoing.length.toLocaleString('en-US')} 字元`;
        };
        if (changed) {
            tabs.append(sentTab, rawTab);
            body.append(tabs);
        }
        body.append(size, pre);
        show('sent');

        const footer = createElement('footer', 'stiae-footer');
        const copy = button('複製', 'fa-copy');
        const done = button('關閉', 'fa-check', 'stiae-primary');
        footer.append(copy, done);

        modal.append(header, body, footer);
        overlay.append(modal);
        hostDocument.body.append(overlay);
        state.activeTextPreview = overlay;

        const dismiss = () => {
            if (state.activeTextPreview !== overlay) return;
            state.activeTextPreview = null;
            hostDocument.removeEventListener('keydown', onKey, true);
            overlay.remove();
        };
        function onKey(event) {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            dismiss();
        }

        sentTab.addEventListener('click', () => show('sent'));
        rawTab.addEventListener('click', () => show('raw'));
        copy.addEventListener('click', async () => {
            try {
                await hostWindow.navigator.clipboard.writeText(pre.textContent);
                toast('success', '已複製到剪貼簿。');
            } catch {
                toast('error', '瀏覽器不允許複製，請自己選取。');
            }
        });
        close.addEventListener('click', dismiss);
        done.addEventListener('click', dismiss);
        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) dismiss();
        });
        hostDocument.addEventListener('keydown', onKey, true);
    }

    async function refreshReference(session) {
        hostWindow.clearTimeout(session.referenceTimer);
        const reference = await buildReference(session);
        // The editor may have been closed while the host was being read.
        if (state.activeEditor !== session) return reference;
        session.reference = reference;
        updateReferenceSummary(session);
        updateWorldbookSummary(session);
        updateRegexSummary(session);
        renderReferenceDetail(session);
        // Only the parts whose text depends on what actually went out. Redrawing the
        // whole picker here would throw away the user's scroll position and open groups
        // every time a box is ticked.
        renderWorldbookNotes(session);
        renderWorldbookSelected(session);
        renderWorldbookSidebar(session);
        return reference;
    }

    function scheduleReferenceRefresh(session) {
        hostWindow.clearTimeout(session.referenceTimer);
        session.referenceTimer = hostWindow.setTimeout(() => {
            persistReferenceInput(session);
            refreshReference(session);
        }, REFERENCE_DEBOUNCE_MS);
    }

    // Shared by the two things that are ticked rather than typed: world info entries and,
    // from 0.8.0, regex rules. Ticking five entries in a row used to run buildReference
    // five times, and each run re-reads the regex rules and re-applies them to every
    // floor and every book entry.
    //
    // ⚠️ Deliberately NOT scheduleReferenceRefresh: that one also persists the reference
    // floor input, which has nothing to do with either of these. And only the
    // recomputation is delayed — the tick itself, the row, and persisting the selection
    // all stay immediate, or the box would look like it did not register the click.
    function scheduleContextRefresh(session) {
        hostWindow.clearTimeout(session.contextRefreshTimer);
        session.contextRefreshTimer = hostWindow.setTimeout(() => {
            refreshReference(session);
        }, REFERENCE_DEBOUNCE_MS);
    }

    // Same class of fuse as REFERENCE_LIST_LIMIT and the lcsOps cellLimit: these rows are
    // built on the whole SillyTavern tab's main thread, and a couple of hundred-entry
    // books would freeze it. Ticked entries are exempt — losing sight of what you already
    // chose is worse than a slightly longer list.
    const WORLDBOOK_ROW_LIMIT = 200;

    function worldbookLabel(entry) {
        return `${entry.book} › ${entry.name || '（未命名條目）'}`;
    }

    function worldbookRow(session, entry) {
        const label = createElement('label', 'stiae-wb-row');
        const box = createElement('input');
        box.type = 'checkbox';
        box.checked = session.worldbookSelection.has(entry.key);
        const text = createElement('div');
        text.append(createElement('strong', '', entry.name || '（未命名條目）'));
        text.append(createElement('div', 'stiae-help', describeWorldbookEntry(entry).join(' · ')));
        text.append(createElement('div', 'stiae-ref-text', referenceSnippet(entry.content)));
        box.addEventListener('change', () => {
            if (box.checked) session.worldbookSelection.set(entry.key, { book: entry.book, uid: entry.uid });
            else session.worldbookSelection.delete(entry.key);
            persistWorldbookSelection(session);
            renderWorldbookSelected(session);
            // The sidebar list is what the editor shows once this window closes, so it
            // follows the tick immediately. Only the recomputed counts wait for the
            // debounce — see scheduleContextRefresh.
            renderWorldbookSidebar(session);
            scheduleContextRefresh(session);
        });
        label.append(box, text);
        return label;
    }

    // Notes are rebuilt after every refresh, which is why "emptied by a regex rule" lives
    // here and not on the row: a row is only redrawn when the list is, and a stale mark
    // saying an entry was dropped when it no longer is would be a lie nobody could catch.
    //
    // Two places want them from 0.8.0: the sidebar section, which is always there, and the
    // picker window, which only exists while it is open. Both get the same text from one
    // pass — a second copy of these rules would be a second chance to drift.
    function renderWorldbookNotes(session) {
        renderWorldbookNotesInto(session, session.worldbookSideNotes);
        renderWorldbookNotesInto(session, session.worldbookNotes);
    }

    function renderWorldbookNotesInto(session, notes) {
        if (!notes) return;
        notes.replaceChildren();
        const note = (kind, text) => notes.append(createElement('div', kind === 'help' ? 'stiae-help' : 'stiae-reference-bad', text));

        if (!worldbookApiAvailable()) {
            note('bad', '你的酒館助手版本沒有這個功能需要的 API（getWorldbook）。更新酒館助手之後就會出現。');
            return;
        }
        if (session.worldbookLoading || session.worldbookRememberedLoading) note('help', '正在讀取世界書…');
        for (const group of session.worldbookBooks.values()) {
            if (group.error) note('bad', `讀不到世界書「${group.book}」：${group.error}`);
        }
        const emptied = session.reference?.worldbook?.emptied || [];
        if (emptied.length) {
            note('bad', `這幾條套用正則後整段變成空的，不會送出：${emptied.map(worldbookLabel).join('、')}。`);
        }
        // A real case now that picks are remembered: swap the character card and its book
        // goes with it. The picks are kept rather than pruned, so switching back restores
        // them — but the notice has to say they are not in this request.
        const missing = session.reference?.worldbook?.missing || [];
        if (missing.length) {
            const named = missing.map(ref => `${ref.book} › #${ref.uid}`).join('、');
            note('bad', `記住的這 ${missing.length} 條在目前的聊天／角色下找不到，這次不會送出：${named}。勾選仍然留著，換回原本的角色卡就會再出現。`);
        }
    }

    // The picker shows one book at a time, so what is already ticked in the *other* books
    // would otherwise be invisible. These chips are the only place the whole selection can
    // be seen and undone without navigating to each book — they carry a ✕ rather than a
    // checkbox so the same entry can never hold two checkboxes that disagree.
    function renderWorldbookSelected(session) {
        const box = session.worldbookSelected;
        if (!box) return;
        box.replaceChildren();
        const chosen = allLoadedWorldbookEntries(session).filter(entry => session.worldbookSelection.has(entry.key));
        if (!chosen.length) return;
        // 勾選中, not 已選: the editor's summary line counts what actually goes out, and a
        // regex rule that empties an entry makes the two numbers differ. See
        // updateWorldbookSummary().
        box.append(createElement('div', 'stiae-help', `勾選中 ${chosen.length} 條（點 ✕ 取消）`));
        const chips = createElement('div', 'stiae-wb-chips');
        for (const entry of chosen) {
            const chip = createElement('span', 'stiae-wb-chip');
            chip.append(createElement('span', '', worldbookLabel(entry)));
            const drop = createElement('button', 'stiae-wb-chip-x', '✕');
            drop.type = 'button';
            drop.title = '取消這一條';
            drop.addEventListener('click', () => {
                session.worldbookSelection.delete(entry.key);
                persistWorldbookSelection(session);
                renderWorldbookList(session);
                renderWorldbookSidebar(session);
                scheduleContextRefresh(session);
            });
            chip.append(drop);
            chips.append(chip);
        }
        box.append(chips);
        const clear = button('全部取消', 'fa-eraser');
        clear.addEventListener('click', () => {
            session.worldbookSelection.clear();
            persistWorldbookSelection(session);
            renderWorldbookList(session);
            renderWorldbookSidebar(session);
            scheduleContextRefresh(session);
        });
        box.append(clear);
    }

    function appendWorldbookRows(session, container, entries, budget) {
        let skipped = 0;
        for (const entry of entries) {
            const chosen = session.worldbookSelection.has(entry.key);
            // Ticked entries never count against the fuse and are never dropped: losing
            // sight of what is costing tokens is worse than drawing a few more rows.
            if (!chosen && budget.left <= 0) {
                skipped += 1;
                continue;
            }
            if (!chosen) budget.left -= 1;
            container.append(worldbookRow(session, entry));
        }
        return skipped;
    }

    // Search mode. Deliberately spans every book rather than the selected one: the whole
    // reason to search is not knowing which book an entry lives in.
    function renderWorldbookSearch(session, container, budget) {
        const query = session.worldbookQuery;
        let skipped = 0;
        let matched = 0;
        for (const group of worldbookBookGroups(session)) {
            const hits = filterWorldbookEntries(group.entries, query);
            if (!hits.length) continue;
            matched += hits.length;
            container.append(createElement('div', 'stiae-wb-booktitle', `${group.book}（${group.origin}）· 符合 ${hits.length} 條`));
            const list = createElement('div', 'stiae-wb-list');
            skipped += appendWorldbookRows(session, list, hits, budget);
            container.append(list);
        }
        if (!matched) {
            container.append(createElement('div', 'stiae-help', session.worldbookAllLoaded
                ? '所有世界書裡都沒有符合的條目。'
                : '正在讀取全部世界書…'));
        }
        if (skipped) {
            container.append(createElement('div', 'stiae-help', `…另外還有 ${skipped} 條沒有列出來，把搜尋字打得更完整一點。`));
        }
    }

    // Browse mode: one book, chosen from the dropdown. This replaced listing every book at
    // once, which became unusable the moment a user had more than a handful of books.
    function renderWorldbookBook(session, container, budget) {
        const group = session.worldbookBooks.get(session.worldbookBook);
        if (!session.worldbookBook) {
            container.append(createElement('div', 'stiae-help', '從上面挑一本世界書，或直接用搜尋。'));
            return;
        }
        if (!group) {
            container.append(createElement('div', 'stiae-help', '正在讀取…'));
            return;
        }
        if (group.error) return;
        if (!group.entries.length) {
            container.append(createElement('div', 'stiae-help', '這本世界書裡沒有條目。'));
            return;
        }
        const list = createElement('div', 'stiae-wb-list');
        const skipped = appendWorldbookRows(session, list, group.entries, budget);
        container.append(list);
        if (skipped) {
            container.append(createElement('div', 'stiae-help', `這本書還有 ${skipped} 條沒有列出來，用搜尋找。`));
        }
    }

    function renderWorldbookPicker(session) {
        const picker = session.worldbookPicker;
        if (!picker) return;
        picker.replaceChildren();
        const placeholder = createElement('option', '', '選一本世界書…');
        placeholder.value = '';
        picker.append(placeholder);
        const addGroup = (label, names, withOrigin) => {
            const usable = [...names];
            if (!usable.length) return;
            const optgroup = createElement('optgroup');
            optgroup.label = label;
            for (const name of usable) {
                const loaded = session.worldbookBooks.get(name);
                const count = loaded && !loaded.error ? ` · ${loaded.entries.length} 條` : '';
                const origin = withOrigin ? `（${worldbookOrigin(session, name)}）` : '';
                const option = createElement('option', '', `${name}${origin}${count}`);
                option.value = name;
                optgroup.append(option);
            }
            picker.append(optgroup);
        };
        addGroup('這個聊天生效的', session.worldbookOrigins.keys(), true);
        addGroup('其他世界書', session.worldbookOtherNames, false);
        picker.value = session.worldbookBook;
    }

    function renderWorldbookList(session) {
        const container = session.worldbookGroups;
        if (!container) return;
        renderWorldbookPicker(session);
        container.replaceChildren();
        const budget = { left: WORLDBOOK_ROW_LIMIT };
        if (session.worldbookQuery.trim()) renderWorldbookSearch(session, container, budget);
        else renderWorldbookBook(session, container, budget);
        renderWorldbookNotes(session);
        renderWorldbookSelected(session);
    }

    async function selectWorldbook(session, name) {
        session.worldbookBook = name;
        renderWorldbookList(session);
        if (!name || !worldbookApiAvailable()) return;
        session.worldbookLoading = true;
        await loadWorldbooks(session, [name]);
        if (state.activeEditor !== session) return;
        session.worldbookLoading = false;
        renderWorldbookList(session);
    }

    // Searching needs every book in memory, which is exactly the cost the dropdown exists
    // to avoid — so it is paid once, only if the user actually searches, and never on
    // simply opening the editor.
    async function loadAllWorldbooksForSearch(session) {
        if (session.worldbookAllLoaded || session.worldbookAllLoading || !worldbookApiAvailable()) return;
        session.worldbookAllLoading = true;
        renderWorldbookList(session);
        await loadWorldbooks(session, [...session.worldbookOrigins.keys(), ...session.worldbookOtherNames]);
        if (state.activeEditor !== session) return;
        session.worldbookAllLoaded = true;
        session.worldbookAllLoading = false;
        renderWorldbookList(session);
    }

    // Opening the picker reads one book, not all of them: whichever the dropdown lands on.
    function openWorldbookPicker(session) {
        if (session.worldbookBook || !worldbookApiAvailable()) return;
        const first = [...session.worldbookOrigins.keys()][0] || session.worldbookOtherNames[0] || '';
        selectWorldbook(session, first);
    }

    // ⚠️ Runs when the editor opens, not when the picker is expanded. A remembered pick
    // has to be in the request whether or not the user ever looks at that section — the
    // whole point is not having to touch it. Only the books the picks actually name are
    // read; the rest stay lazy.
    async function loadRememberedWorldbooks(session) {
        if (!session.worldbookSelection.size || !worldbookApiAvailable()) return;
        const names = [...session.worldbookSelection.values()].map(ref => ref.book);
        // ⚠️ Deliberately NOT session.worldbookLoading. That flag guards the book the
        // dropdown is loading, and borrowing it here would let one finish and clear the
        // other's flag, leaving a spinner that never resolves.
        session.worldbookRememberedLoading = true;
        await loadWorldbooks(session, names);
        if (state.activeEditor !== session) return;
        session.worldbookRememberedLoading = false;
        renderWorldbookList(session);
        await refreshReference(session);
    }

    // The sidebar's own list of what is ticked. 0.7.0 moved the picker into a window of
    // its own, which fixed the cramped nested scrollers but left the editor knowing only
    // a count — "已附加 5 條" cannot tell you *which* five, so checking meant reopening
    // the window every time. Picking still happens in that window; seeing does not.
    //
    // Every row opens the entry in full, and carries a ✕ so a pick can be dropped without
    // going back into the picker at all.
    function renderWorldbookSidebar(session) {
        const list = session.worldbookList;
        if (!list) return;
        list.replaceChildren();
        // ⚠️ Keyed off what is ticked, NOT off what is loaded and drawable below. The
        // difference is the case that needs this button most: after a character card is
        // swapped out, its picks are kept but their books are gone, so nothing renders —
        // and clearing them one ✕ at a time is impossible because there are no rows.
        session.worldbookClear?.classList.toggle('stiae-hidden', !session.worldbookSelection.size);
        if (!worldbookApiAvailable()) return;
        const chosen = allLoadedWorldbookEntries(session).filter(entry => session.worldbookSelection.has(entry.key));
        if (!chosen.length) {
            if (!session.worldbookSelection.size) list.append(createElement('div', 'stiae-help', '還沒勾選任何條目。'));
            return;
        }
        // ⚠️ Both halves of the last refresh, not just `sent`. An entry a regex rule
        // emptied lives in `emptied`, and falling back to the catalogue for it would draw
        // the untouched text under a row marked 正則後為空 — the row would contradict
        // itself. Missing from both means the refresh has not landed yet, and then the
        // catalogue text is the honest thing to show.
        const processed = new Map([
            ...(session.reference?.worldbook?.sent || []),
            ...(session.reference?.worldbook?.emptied || []),
        ].map(entry => [entry.key, entry]));
        for (const entry of chosen) {
            const applied = processed.get(entry.key);
            const emptied = Boolean(applied) && !applied.content.length;
            list.append(sideRow({
                meta: `${entry.book} › ${entry.name || '（未命名條目）'}${emptied ? ' · 正則後為空' : ''}`,
                snippet: referenceSnippet(applied ? applied.content : entry.content),
                dim: emptied,
                openTitle: '看這一條的完整內容',
                onOpen: () => openTextPreview({
                    title: entry.name || '（未命名條目）',
                    subtitle: entry.book,
                    sent: applied ? applied.content : entry.content,
                    raw: applied ? applied.raw : entry.content,
                }),
                onRemove: () => {
                    session.worldbookSelection.delete(entry.key);
                    persistWorldbookSelection(session);
                    renderWorldbookList(session);
                    renderWorldbookSidebar(session);
                    scheduleContextRefresh(session);
                },
            }));
        }
    }

    // The picks are saved as they are ticked, so this window has nothing to confirm and
    // nothing to cancel — closing it is the only exit, and 完成 says so.
    //
    // ⚠️ It claims Escape through state.activeWorldbook. onDocumentKeydown closes the
    // editor on Escape, so without that flag picking entries and pressing Escape would
    // close the editor and the draft with it.
    function openWorldbookDialog(session) {
        if (state.activeWorldbook || state.activeEditor !== session) return;

        const overlay = createElement('div', `${ROOT_CLASS} stiae-overlay stiae-sub-layer`);
        const modal = createElement('section', 'stiae-settings-modal stiae-wb-modal');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        const header = createElement('header', 'stiae-header');
        header.append(createElement('strong', '', `世界書條目 · 第 ${session.messageId} 樓`));
        const close = createElement('button', 'stiae-close', '×');
        close.type = 'button';
        close.title = '完成';
        header.append(close);

        const body = createElement('div', 'stiae-wb-body');
        const searchRow = createElement('div', 'stiae-reference-row');
        const search = createElement('input', 'stiae-reference-input');
        search.type = 'text';
        search.placeholder = '搜尋全部世界書（條目名、書名或關鍵字）';
        search.value = session.worldbookQuery;
        const clearSearch = button('清除', 'fa-eraser');
        searchRow.append(search, clearSearch);

        const pickerRow = createElement('div', 'stiae-reference-row');
        const picker = createElement('select', 'stiae-wb-picker');
        pickerRow.append(picker);

        const help = createElement(
            'div',
            'stiae-help',
            '一次挑一本；搜尋會跨全部世界書。唯讀、會記住，關掉就生效。',
        );
        const notes = createElement('div', 'stiae-reference-notes');
        const selected = createElement('div', 'stiae-wb-selected');
        const groups = createElement('div', 'stiae-wb-groups');
        body.append(searchRow, pickerRow, help, notes, selected, groups);

        const footer = createElement('footer', 'stiae-footer');
        const done = button('完成', 'fa-check', 'stiae-primary');
        footer.append(done);

        modal.append(header, body, footer);
        overlay.append(modal);
        hostDocument.body.append(overlay);

        session.worldbookNotes = notes;
        session.worldbookSelected = selected;
        session.worldbookGroups = groups;
        session.worldbookPicker = picker;
        state.activeWorldbook = overlay;

        const dismiss = () => {
            if (state.activeWorldbook !== overlay) return;
            state.activeWorldbook = null;
            hostDocument.removeEventListener('keydown', onKey, true);
            hostWindow.clearTimeout(session.worldbookTimer);
            overlay.remove();
            // These nodes leave the document with the dialog. Dropping the references
            // makes every render function above no-op on its own guard clause instead of
            // quietly painting into a detached tree.
            session.worldbookNotes = null;
            session.worldbookSelected = null;
            session.worldbookGroups = null;
            session.worldbookPicker = null;
            // Anything still on the debounce lands now, so the summary line the editor
            // shows can never be one tick behind what was ticked.
            refreshReference(session);
        };
        function onKey(event) {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            dismiss();
        }

        close.addEventListener('click', dismiss);
        done.addEventListener('click', dismiss);
        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) dismiss();
        });
        hostDocument.addEventListener('keydown', onKey, true);

        picker.addEventListener('change', () => {
            // Picking a book is a browse action, so it also drops out of search mode —
            // otherwise the dropdown would visibly change while the list ignored it.
            search.value = '';
            session.worldbookQuery = '';
            selectWorldbook(session, picker.value);
        });
        search.addEventListener('input', () => {
            hostWindow.clearTimeout(session.worldbookTimer);
            session.worldbookTimer = hostWindow.setTimeout(() => {
                session.worldbookQuery = search.value;
                renderWorldbookList(session);
                if (session.worldbookQuery.trim()) loadAllWorldbooksForSearch(session);
            }, REFERENCE_DEBOUNCE_MS);
        });
        clearSearch.addEventListener('click', () => {
            search.value = '';
            session.worldbookQuery = '';
            renderWorldbookList(session);
        });

        renderWorldbookList(session);
        openWorldbookPicker(session);
        search.focus();
    }

    // One collapsible block of the sidebar. The open/closed state is remembered per
    // section (see normalizeSettings) because it is a working habit rather than a
    // per-editor decision.
    //
    // ⚠️ On a phone every section starts closed regardless of what was remembered: the
    // sidebar stacks above the text there, and three open sections would leave nothing
    // to edit in. Only opening one is ever written back, and that matches the desktop
    // default anyway.
    function buildSideSection(session, key, title) {
        const details = createElement('details', 'stiae-side-section');
        details.open = state.settings.sidebarSections[key] && hostWindow.innerWidth > 760;
        const summary = createElement('summary', 'stiae-side-summary');
        summary.append(createElement('span', '', title));
        const count = createElement('span', 'stiae-side-count');
        summary.append(count);
        const body = createElement('div', 'stiae-side-body');
        details.append(summary, body);
        details.addEventListener('toggle', () => {
            state.settings.sidebarSections[key] = details.open;
            saveSettings();
        });
        return { details, count, body };
    }

    function buildFloorsSection(session) {
        const section = buildSideSection(session, 'floors', '參考樓層');
        session.floorsCount = section.count;

        const row = createElement('div', 'stiae-reference-row');
        const input = createElement('input', 'stiae-reference-input');
        input.type = 'text';
        input.placeholder = '例如：30, 42-46';
        input.value = session.referenceInput;
        const quickFive = button('前 5 樓', 'fa-backward');
        const quickTen = button('前 10 樓', 'fa-backward-fast');
        const clear = button('清除', 'fa-eraser');
        row.append(input, quickFive, quickTen, clear);

        const help = createElement(
            'div',
            'stiae-help',
            '唯讀，不會寫回聊天。換聊天就清空。點一列可以看那一樓的完整內文。',
        );
        const notes = createElement('div', 'stiae-reference-notes');
        const list = createElement('div', 'stiae-reference-list');

        section.body.append(row, help, notes, list);
        session.referenceNotes = notes;
        session.referenceList = list;
        // Says 未指定 straight away rather than sitting blank until the first refresh
        // lands. Same reason the other two sections fill their counts as they are built.
        updateReferenceSummary(session);

        // The quick buttons only type for you — the text box stays the single source
        // of truth. That is what keeps "前 5 樓" from being ambiguous: the answer is
        // spelled out as 42-46 the moment you press it, counted back from the floor
        // being edited rather than from the end of the chat.
        const fillRecent = count => {
            const to = session.messageId - 1;
            const from = Math.max(0, session.messageId - count);
            if (to < from) {
                toast('info', '這一樓前面沒有其他樓層。');
                return;
            }
            input.value = from === to ? String(from) : `${from}-${to}`;
            session.referenceInput = input.value;
            persistReferenceInput(session);
            section.details.open = true;
            refreshReference(session);
        };

        input.addEventListener('input', () => {
            session.referenceInput = input.value;
            // Saved on the same debounce as the refresh rather than per keystroke: this
            // writes the whole settings table through the host each time.
            scheduleReferenceRefresh(session);
        });
        quickFive.addEventListener('click', () => fillRecent(5));
        quickTen.addEventListener('click', () => fillRecent(10));
        clear.addEventListener('click', () => {
            input.value = '';
            session.referenceInput = '';
            persistReferenceInput(session);
            refreshReference(session);
        });

        return section.details;
    }

    function buildWorldbookSection(session) {
        const section = buildSideSection(session, 'worldbook', '世界書');
        session.worldbookCount = section.count;

        const row = createElement('div', 'stiae-reference-row');
        const open = button('選條目', 'fa-book-open');
        open.addEventListener('click', () => openWorldbookDialog(session));
        // Beside 選條目 rather than under the list: picks are remembered across editors,
        // so wanting rid of all of them is a thing you arrive wanting to do, and it should
        // not need scrolling past the very rows you are clearing. Hidden while nothing is
        // ticked so the section stays quiet on a fresh editor.
        const clear = button('全部取消', 'fa-eraser', 'stiae-hidden');
        clear.addEventListener('click', () => {
            session.worldbookSelection.clear();
            persistWorldbookSelection(session);
            // No confirmation, matching the same button inside the picker: this drops a
            // selection, not content, and one of the two asking would be the odd one out.
            renderWorldbookList(session);
            renderWorldbookSidebar(session);
            scheduleContextRefresh(session);
        });
        row.append(open, clear);
        const help = createElement('div', 'stiae-help', '唯讀，會記住。點一列可以看整條的內容。');
        const notes = createElement('div', 'stiae-reference-notes');
        const list = createElement('div', 'stiae-reference-list');

        section.body.append(row, help, notes, list);
        session.worldbookSideNotes = notes;
        session.worldbookClear = clear;
        session.worldbookList = list;
        updateWorldbookSummary(session);
        renderWorldbookSidebar(session);
        return section.details;
    }

    // Moved out of the settings dialog in 0.8.0 and, with it, out of that dialog's draft
    // model: a tick here takes effect and is saved immediately, exactly like a world info
    // pick. That is the whole reason it moved — deciding which rules to run is part of
    // setting up a request, not part of configuring the tool, and it was two clicks and a
    // 儲存設定 away from the thing it changes.
    //
    // ⚠️ The settings dialog must not keep a copy. One list committed on save and one
    // committed on tick is two checkboxes for one setting that can disagree.
    function buildRegexSection(session) {
        const section = buildSideSection(session, 'regex', '正則規則');
        session.regexCount = section.count;
        session.regexBody = section.body;
        updateRegexSummary(session);
        section.body.append(createElement('div', 'stiae-help', '正在讀取 SillyTavern 的正則規則…'));
        // Read once per editor, like the world info catalogue: rules changed in
        // SillyTavern while an editor is open need the editor reopened.
        readTavernRegexes().then(rules => {
            if (state.activeEditor !== session) return;
            renderRegexRules(session, rules);
        });
        return section.details;
    }

    function renderRegexRules(session, rules) {
        const body = session.regexBody;
        if (!body) return;
        body.replaceChildren();
        body.append(createElement(
            'div',
            'stiae-help',
            '套用在參考資料上。勾了就跑：不看深度、目的地，也不看它在 SillyTavern 裡是不是停用。所以可以建一條只給編輯用的規則。',
        ));
        body.append(createElement(
            'div',
            'stiae-help',
            '唯一的例外是「來源」——寫給 AI 輸出的規則不會套到使用者樓層，反之亦然。',
        ));
        body.append(createElement(
            'div',
            'stiae-help',
            '⚠ 代表那條規則有自己的條件，這裡會忽略。成套按深度分工的規則不要整組勾——條件被拿掉後它們會互相把內容刪光。',
        ));
        if (rules === null) {
            body.append(createElement('div', 'stiae-reference-bad', '讀不到 SillyTavern 的正則規則。參考資料會以原始文字送出。'));
            return;
        }
        const known = new Set(rules.map(rule => String(rule.id)));
        const orphans = state.settings.regexRuleIds.filter(id => !known.has(id));
        // Selections are stored by rule id, and character-scoped rules disappear
        // with the character card. Saying so beats dropping them without a word.
        if (orphans.length) {
            body.append(createElement(
                'div',
                'stiae-reference-bad',
                `有 ${orphans.length} 條已勾選的規則在目前角色下找不到，這次不會套用。切回原本的角色卡就會再出現。`,
            ));
        }
        if (!rules.length) {
            body.append(createElement('div', 'stiae-help', 'SillyTavern 裡目前沒有任何正則規則。'));
            return;
        }
        const list = createElement('div', 'stiae-regex-list');
        for (const rule of rules) {
            const id = String(rule.id);
            const label = createElement('label', 'stiae-regex-row');
            const box = createElement('input');
            box.type = 'checkbox';
            box.checked = state.settings.regexRuleIds.includes(id);
            const text = createElement('div');
            text.append(createElement('strong', '', String(rule.script_name || '未命名規則')));
            const marks = [rule.scope === 'character' ? '角色專屬' : '全域'];
            if (!rule.enabled) marks.push('ST 中已停用');
            const scopeNote = describeRuleScope(rule);
            if (scopeNote) marks.push(scopeNote);
            if (ruleUsesMacro(rule)) marks.push('含巨集，本工具不會展開');
            text.append(createElement('div', 'stiae-help', marks.join(' · ')));
            for (const override of describeRuleOverrides(rule)) {
                text.append(createElement('div', 'stiae-regex-override', `⚠ ${override}`));
            }
            box.addEventListener('change', () => {
                state.settings.regexRuleIds = box.checked
                    ? [...new Set([...state.settings.regexRuleIds, id])]
                    : state.settings.regexRuleIds.filter(value => value !== id);
                // Saved on the tick, not on some later commit: an editor can be closed by
                // a route that never reaches a save, and a rule selection that silently
                // failed to stick is the annoyance this move exists to remove.
                saveSettings();
                updateRegexSummary(session);
                scheduleContextRefresh(session);
            });
            label.append(box, text);
            list.append(label);
        }
        body.append(list);
    }

    function buildSidebar(session) {
        const side = createElement('aside', 'stiae-side');
        const scroll = createElement('div', 'stiae-side-scroll');
        scroll.append(buildFloorsSection(session), buildWorldbookSection(session), buildRegexSection(session));
        const foot = createElement('div', 'stiae-side-foot');
        const preview = button('預覽這次的請求', 'fa-eye');
        preview.addEventListener('click', () => openRequestPreview(session));
        foot.append(preview);
        side.append(scroll, foot);
        return side;
    }

    // The instruction is the one slot that is purely a variable: it lands at the top of
    // the user message as `Task: …` and, when there is reference material, again at the
    // bottom as the reminder. Both positions are the same whichever command is pressed,
    // so a marker stands in for it.
    const PREVIEW_INSTRUCTION = '〔這裡會換成你按下的那個指令的指示〕';

    // What this request looks like before any command is pressed — built by the same
    // buildPrompt() the real request uses, so the shape cannot drift from reality.
    //
    // ⚠️ The mode buttons are not decoration. The instruction may be a placeholder, but
    // the protocol above it cannot be: 局部修補 and 全文改寫 are two entirely different
    // system messages (search/replace pairs vs a single replacement block), and the
    // patch-specific reference rule appears for one of them only. Picking one and
    // calling it "the request" would show a protocol the user is not going to send.
    //
    // What this deliberately cannot show: a command that froze its own card list sends
    // that instead of the global principles. The note under the buttons says so, because
    // a preview that quietly differs from the request is worse than no preview.
    //
    // The scope is read from the textarea at the moment it renders, so a selection is
    // reflected — and nothing here freezes any offset, because nothing here is sent.
    function openRequestPreview(session) {
        if (state.activeRequestPreview || state.activeEditor !== session) return;

        const overlay = createElement('div', `${ROOT_CLASS} stiae-overlay stiae-sub-layer`);
        const modal = createElement('section', 'stiae-settings-modal stiae-preview-modal');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        const header = createElement('header', 'stiae-header');
        header.append(createElement('strong', '', `預覽請求 · 第 ${session.messageId} 樓`));
        const close = createElement('button', 'stiae-close', '×');
        close.type = 'button';
        close.title = '關閉';
        header.append(close);

        const body = createElement('div', 'stiae-preview-body');
        const pick = createElement('div', 'stiae-preview-pick');
        pick.append(createElement('span', '', '編輯模式：'));
        const patchTab = button('局部修補', 'fa-code-merge');
        const rewriteTab = button('全文改寫', 'fa-pen');
        pick.append(patchTab, rewriteTab);
        const modeHelp = createElement(
            'div',
            'stiae-help',
            '不論按哪個指令，你的要求都會落在同一個位置，所以這裡先用一段假的代替。但「局部修補」和「全文改寫」教 AI 回話的方式完全不同，想看哪一種請自己切。如果某條指令有自己專屬的提示詞模組，它實際送出的會是那一份，不是這裡顯示的。',
        );
        const summary = createElement('div', 'stiae-help');
        const content = createElement('div', 'stiae-preview-rows');
        body.append(pick, modeHelp, summary, content);

        const footer = createElement('footer', 'stiae-footer');
        const copy = button('複製全文', 'fa-copy');
        const done = button('關閉', 'fa-check', 'stiae-primary');
        footer.append(copy, done);

        modal.append(header, body, footer);
        overlay.append(modal);
        hostDocument.body.append(overlay);
        state.activeRequestPreview = overlay;

        let plain = '';
        const render = async () => {
            const mode = session.previewMode === 'replacement' ? 'replacement' : 'patch';
            patchTab.classList.toggle('stiae-tab-on', mode === 'patch');
            rewriteTab.classList.toggle('stiae-tab-on', mode === 'replacement');
            // A stand-in for a real command: the placeholder instruction and the chosen
            // mode. The card list is the global one, so a command that has frozen its own
            // list will send something else — the note under the two buttons says so.
            const action = { instruction: PREVIEW_INSTRUCTION, mode };
            const scope = scopeFromTextarea(session.textarea);
            summary.textContent = '正在組裝…';
            const reference = await refreshReference(session);
            if (state.activeRequestPreview !== overlay) return;
            const messages = buildPrompt(action, scope, session.role, {
                referenceBlock: reference.block,
                cards: state.settings.promptCards,
            });
            const size = messages.reduce((total, message) => total + message.content.length, 0);
            summary.textContent = [
                `${size.toLocaleString('en-US')} 字元（不含指示本身）`,
                scope.hasSelection ? `可編輯範圍＝反白的 ${scope.end - scope.start} 個字元` : '可編輯範圍＝整個樓層',
            ].join(' · ');
            plain = messages.map(message => `${message.role}:\n${message.content}`).join('\n\n');
            content.replaceChildren();
            for (const message of messages) {
                content.append(createElement('div', 'stiae-request-role', MESSAGE_ROLE_LABELS[message.role] || message.role));
                content.append(createElement('pre', 'stiae-preview-pre', message.content));
            }
            // No "the last message must be a user turn" check here, and none is needed:
            // 目標內文 is pinned last and always produces text, so the merged list always
            // ends on a user message no matter how the free stretch is arranged. That is
            // a second thing the pinning buys, on top of keeping reference material ahead
            // of the prose being edited.
        };

        const dismiss = () => {
            if (state.activeRequestPreview !== overlay) return;
            state.activeRequestPreview = null;
            hostDocument.removeEventListener('keydown', onKey, true);
            overlay.remove();
        };
        function onKey(event) {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            dismiss();
        }

        patchTab.addEventListener('click', () => { session.previewMode = 'patch'; render(); });
        rewriteTab.addEventListener('click', () => { session.previewMode = 'replacement'; render(); });
        copy.addEventListener('click', async () => {
            try {
                await hostWindow.navigator.clipboard.writeText(plain);
                toast('success', '已複製到剪貼簿。');
            } catch {
                toast('error', '瀏覽器不允許複製，請自己選取。');
            }
        });
        close.addEventListener('click', dismiss);
        done.addEventListener('click', dismiss);
        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) dismiss();
        });
        hostDocument.addEventListener('keydown', onKey, true);
        render();
    }

    // Replaces window.confirm(), which cannot be relied on here.
    //
    // ⚠️ The script runs inside a TavernHelper iframe. When that iframe is sandboxed
    // without `allow-modals`, the browser does not merely refuse the dialog — it
    // returns `false` and says nothing. Every `if (!confirm(...)) return;` then became
    // a silent no-op: the floor could not be saved, and an editor with an unsaved
    // draft could not even be closed. Nothing was logged and no message was shown,
    // because from the code's point of view the user had simply clicked "cancel".
    //
    // This dialog is drawn by the tool itself, so it cannot be taken away by a sandbox
    // flag or a browser policy change. The two-stage save (accept only updates the
    // draft; writing back needs a second confirmation) is unchanged — only the kind of
    // window it uses.
    function showConfirm(message, { confirmLabel = '確定', danger = false } = {}) {
        // One at a time. Without this, a double click on 儲存樓層 would stack two.
        if (state.activeConfirm) return Promise.resolve(false);
        return new Promise(resolve => {
            const overlay = createElement('div', `${ROOT_CLASS} stiae-overlay stiae-confirm-layer`);
            const modal = createElement('section', 'stiae-confirm-modal');
            modal.setAttribute('role', 'alertdialog');
            modal.setAttribute('aria-modal', 'true');
            const text = createElement('div', 'stiae-confirm-text', message);
            const footer = createElement('footer', 'stiae-footer');
            const cancel = button('取消', 'fa-xmark');
            const accept = button(confirmLabel, 'fa-check', danger ? 'stiae-danger' : 'stiae-primary');
            footer.append(cancel, accept);
            modal.append(text, footer);
            overlay.append(modal);
            hostDocument.body.append(overlay);

            const finish = value => {
                if (state.activeConfirm !== overlay) return;
                state.activeConfirm = null;
                hostDocument.removeEventListener('keydown', onKey, true);
                overlay.remove();
                resolve(value);
            };
            function onKey(event) {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(false);
                } else if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    finish(true);
                }
            }
            state.activeConfirm = overlay;
            cancel.addEventListener('click', () => finish(false));
            accept.addEventListener('click', () => finish(true));
            // Clicking the backdrop cancels, matching every other dialog here. It never
            // confirms — an accidental click must not write to the chat.
            overlay.addEventListener('mousedown', event => {
                if (event.target === overlay) finish(false);
            });
            hostDocument.addEventListener('keydown', onKey, true);
            accept.focus();
        });
    }

    function closeDetailsMenus(container) {
        for (const detail of container.querySelectorAll('details[open]')) detail.removeAttribute('open');
    }

    // The menu is position: fixed (see the stylesheet for why), so it no longer follows
    // the button it belongs to — these coordinates are what put it back under it.
    // Recomputed on every open rather than once, because the editor window can be dragged
    // and resized between one open and the next.
    function positionToolbarMenu(anchor, menu) {
        const rect = anchor.getBoundingClientRect();
        menu.style.top = `${Math.round(rect.bottom + 6)}px`;
        // Right-aligned with the button, but never off the left edge of the viewport.
        const fromRight = Math.round(hostWindow.innerWidth - rect.right);
        menu.style.right = `${Math.min(Math.max(fromRight, 8), Math.max(8, hostWindow.innerWidth - 200))}px`;
        // Whatever room is left below the button. Without this the menu would simply run
        // off the bottom of a short window — the clipping bug in a different costume.
        menu.style.maxHeight = `${Math.max(140, Math.round(hostWindow.innerHeight - rect.bottom - 22))}px`;
    }

    // One dropdown, used both for a group's folder and for the ⋯ overflow menu.
    // pinnedCount says how many of these commands are already pinned to the toolbar as
    // separate buttons: those get .stiae-mobile-menu-item so desktop hides the duplicate
    // while mobile — which has no pins — still lists them.
    function buildCommandMenu(session, label, icon, commands, { pinnedCount = 0, folder = false } = {}) {
        const details = createElement('details', 'stiae-more');
        const summary = createElement('summary', `menu_button stiae-button${folder ? ' stiae-folder' : ''}`);
        summary.append(createElement('i', `fa-solid ${icon}`));
        summary.append(createElement('span', '', label));
        const menu = createElement('div', 'stiae-menu');
        commands.forEach((command, index) => {
            const item = button(command.name, command.icon, index < pinnedCount ? 'stiae-mobile-menu-item' : '');
            item.addEventListener('click', () => {
                details.removeAttribute('open');
                runAiAction(session, command);
            });
            menu.append(item);
        });
        details.addEventListener('toggle', () => {
            if (details.open) positionToolbarMenu(summary, menu);
        });
        details.append(summary, menu);
        return details;
    }

    function renderEditorToolbar(session) {
        const toolbar = session.toolbar;
        toolbar.replaceChildren();

        const { builtins, customs } = resolveCommands(state.settings);
        for (const action of builtins.filter(command => command.visible && command.instruction.trim())) {
            const item = button(action.name, action.icon);
            item.addEventListener('click', () => runAiAction(session, action));
            toolbar.append(item);
        }

        const visibleCommands = customs.filter(command => command.visible && command.instruction.trim());

        // A group is a folder button on the toolbar, not a heading buried inside ⋯.
        // 0.7.0 first shipped it as headings in the ⋯ menu and it was invisible in
        // practice: the toolbar looked exactly like an ungrouped one, so grouping seemed
        // not to work at all. A folder you can point at is the whole value of grouping.
        const folders = new Map();
        const loose = [];
        for (const command of visibleCommands) {
            if (!command.group) {
                loose.push(command);
                continue;
            }
            if (!folders.has(command.group)) folders.set(command.group, []);
            folders.get(command.group).push(command);
        }

        // ⚠️ Laid out in the stored order, NOT folders-then-loose. The toolbar reads like
        // a browser's bookmarks bar, so where a thing sits has to be the owner's decision:
        // a folder appears where its first member sits, and dragging that member in the
        // settings list is how you move the folder. Hard-coding folders to the left made
        // the order look arbitrary — because it was.
        const placedFolders = new Set();
        let pinnedLoose = 0;
        for (const command of visibleCommands) {
            const group = command.group || '';
            if (group) {
                if (placedFolders.has(group)) continue;
                placedFolders.add(group);
                toolbar.append(buildCommandMenu(session, group, 'fa-folder', folders.get(group), { folder: true }));
                continue;
            }
            // Ungrouped commands keep the 0.6.1 behaviour exactly: the first three pinned
            // on desktop, all of them in ⋯. Someone who never groups sees no change.
            if (pinnedLoose >= 3) continue;
            pinnedLoose += 1;
            const item = button(command.name, command.icon, 'stiae-desktop-pin');
            item.addEventListener('click', () => runAiAction(session, command));
            toolbar.append(item);
        }
        if (loose.length) {
            const overflow = buildCommandMenu(session, '更多', 'fa-ellipsis', loose, { pinnedCount: 3 });
            // With three or fewer ungrouped commands they are all pinned already, so on
            // desktop this menu would open onto nothing. Mobile has no pins, so it still
            // needs it. (Present since 0.6.1; the folders just made it easy to see.)
            if (loose.length <= 3) overflow.classList.add('stiae-mobile-menu-item');
            toolbar.append(overflow);
        }

        const custom = button('臨時指令', 'fa-comment-dots');
        custom.addEventListener('click', async () => {
            const action = await showOneOffCommand(session);
            if (action) runAiAction(session, action);
        });
        toolbar.append(custom);

        toolbar.append(createElement('div', 'stiae-toolbar-spacer'));
        const settingsButton = button('設定', 'fa-gear', 'stiae-icon-button');
        settingsButton.title = 'AI 內文編輯器設定';
        settingsButton.addEventListener('click', () => openSettings());
        toolbar.append(settingsButton);
        session.settingsButton = settingsButton;
        markToolbarUpdateBadge(session);
    }

    // ══════ 編輯器行為：開啟、儲存、關閉 ══════

    async function requestCloseEditor(session, force = false) {
        if (!session || state.activeEditor !== session) return true;
        session.draft = session.textarea.value;
        if (!force && session.draft !== session.baseText) {
            const confirmed = await showConfirm('這個樓層有尚未儲存的修改。要捨棄草稿嗎？', { confirmLabel: '捨棄草稿', danger: true });
            if (!confirmed) return false;
            // The editor may have been closed or replaced while the dialog was up.
            if (state.activeEditor !== session) return true;
        }
        hostWindow.clearTimeout(session.referenceTimer);
        hostWindow.clearTimeout(session.worldbookTimer);
        hostWindow.clearTimeout(session.contextRefreshTimer);
        // These windows belong to this editor. Left open they would go on ticking entries
        // into, or previewing a request for, a session that no longer exists.
        state.activeWorldbook?.remove();
        state.activeWorldbook = null;
        state.activeTextPreview?.remove();
        state.activeTextPreview = null;
        state.activeRequestPreview?.remove();
        state.activeRequestPreview = null;
        captureEditorRect(session.modal);
        session.overlay.remove();
        state.activeEditor = null;
        return true;
    }

    async function saveEditor(session) {
        const draft = session.textarea.value;
        if (draft === session.baseText) {
            toast('info', '樓層內容沒有變更。');
            requestCloseEditor(session, true);
            return;
        }

        const current = getMessage(session.messageId);
        const swiped = getMessage(session.messageId, true);
        const currentSwipeId = Number.isInteger(swiped?.swipe_id) ? swiped.swipe_id : 0;
        if (!current || current.message !== session.baseText || currentSwipeId !== session.swipeId) {
            toast('error', '這個樓層或目前 swipe 已在外部變更。請關閉編輯器後重新開啟，避免覆蓋新內容。');
            session.scopeNotice.textContent = '偵測到外部變更：目前禁止儲存。';
            session.scopeNotice.classList.add('is-selection');
            return;
        }

        // ⚠️ This sentence is the only place that unconditionally names the write
        // target. The optimistic lock above only catches a swipe that changed *after*
        // the editor opened; a user who was already sitting on the wrong swipe passes
        // it silently. The two guard different things — do not fold them together.
        const confirmed = await showConfirm(
            `確定要把草稿寫入第 ${session.messageId} 樓目前顯示的 swipe 嗎？`,
            { confirmLabel: '寫入樓層' },
        );
        if (!confirmed) return;
        // The dialog is not instant, so re-check that this editor is still the live one.
        if (state.activeEditor !== session) return;

        try {
            await tavern.setChatMessages([{ message_id: session.messageId, message: draft }], { refresh: 'affected' });
            session.baseText = draft;
            session.draft = draft;
            toast('success', `第 ${session.messageId} 樓已更新。`);
            requestCloseEditor(session, true);
        } catch (error) {
            console.error('[ST Inline AI Editor] Failed to save message.', error);
            toast('error', '寫入樓層失敗，草稿仍保留在編輯器中。');
        }
    }

    async function openEditor(messageId) {
        if (state.activeEditor) {
            if (state.activeEditor.messageId === messageId) return;
            if (!(await requestCloseEditor(state.activeEditor))) return;
        }

        const message = getMessage(messageId);
        const swiped = getMessage(messageId, true);
        if (!message || !['user', 'assistant'].includes(message.role)) {
            toast('warning', '這個樓層不是可編輯的使用者或 AI 訊息。');
            return;
        }

        const overlay = createElement('div', `${ROOT_CLASS} stiae-overlay`);
        const modal = createElement('section', 'stiae-modal');
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        const header = createElement('header', 'stiae-header');
        const swipeId = Number.isInteger(swiped?.swipe_id) ? swiped.swipe_id : 0;
        const roleLabel = message.role === 'user' ? '使用者' : 'AI';
        header.append(createElement('strong', '', `AI 內文編輯器 · 第 ${messageId} 樓 · ${roleLabel} · Swipe ${swipeId + 1}`));
        const close = createElement('button', 'stiae-close', '×');
        close.type = 'button';
        close.title = '關閉';
        header.append(close);
        const toolbar = createElement('div', 'stiae-toolbar');
        const scopeNotice = createElement('div', 'stiae-scope');
        // The text and the sidebar are siblings inside one row from 0.8.0. Before that
        // everything was one column and the reference section competed with the textarea
        // for the same vertical space.
        const main = createElement('div', 'stiae-main');
        const workspace = createElement('div', 'stiae-workspace');
        const body = createElement('div', 'stiae-editor-body');
        const textarea = createElement('textarea', 'stiae-editor-text');
        textarea.value = message.message;
        textarea.spellcheck = false;
        body.append(textarea);
        workspace.append(scopeNotice, body);
        const footer = createElement('footer', 'stiae-footer');
        const cancel = button('取消', 'fa-xmark');
        const save = button('儲存樓層', 'fa-check', 'stiae-primary');
        footer.append(cancel, save);

        const session = {
            messageId: Number(messageId),
            swipeId,
            role: message.role,
            name: message.name,
            baseText: message.message,
            draft: message.message,
            overlay,
            modal,
            toolbar,
            scopeNotice,
            textarea,
            // Reference material lives and dies with this editor, exactly like the
            // draft and the selection.
            // Restored only when the stored chat id matches this chat — see
            // restoredReferenceInput(). Everything else about the reference material is
            // unchanged: it is read-only and never written back.
            referenceInput: restoredReferenceInput(),
            reference: null,
            referenceTimer: null,
            // World info picks are remembered across editors, so they start populated.
            // The catalogue does not: books are read on demand, and the `*Loaded` flags
            // rather than the map's emptiness say whether a group has been fetched.
            worldbookSelection: new Map(state.settings.worldbookSelection
                .map(ref => [worldbookEntryKey(ref.book, ref.uid), ref])),
            worldbookOrigins: worldbookApiAvailable() ? collectActiveWorldbooks() : new Map(),
            worldbookOtherNames: [],
            worldbookBooks: new Map(),
            worldbookBook: '',
            worldbookAllLoaded: false,
            worldbookAllLoading: false,
            worldbookLoading: false,
            worldbookRememberedLoading: false,
            worldbookQuery: '',
            worldbookTimer: null,
            contextRefreshTimer: null,
            // Which protocol the request preview is showing. Editor-scoped like the
            // one-off command, so reopening it stays where it was left. 局部修補 first
            // because it is the mode a new command starts on and the one whose protocol
            // has an extra rule that only shows up with reference material attached.
            previewMode: 'patch',
            // Kept only for this editor's lifetime so re-opening "臨時指令" after a run
            // starts pre-filled instead of blank. Not persisted to settings — a fresh
            // editor on a different floor (or reopening this one) starts empty again.
            oneOffInstruction: '',
        };
        session.worldbookOtherNames = worldbookApiAvailable()
            ? collectOtherWorldbookNames(session.worldbookOrigins)
            : [];
        state.activeEditor = session;

        main.append(workspace, buildSidebar(session));
        modal.append(header, toolbar, main, footer);
        overlay.append(modal);
        hostDocument.body.append(overlay);
        placeEditorModal(modal);
        makeDraggable(modal, header);

        renderEditorToolbar(session);
        updateScopeNotice(session);
        refreshReference(session);
        // Reads only the books the remembered picks name, and refreshes again once they
        // land. Without this a remembered pick would sit in the summary line but be
        // absent from the request until the user happened to expand the picker.
        loadRememberedWorldbooks(session);

        textarea.addEventListener('input', () => { session.draft = textarea.value; });
        for (const eventName of ['select', 'keyup', 'mouseup', 'touchend']) {
            textarea.addEventListener(eventName, () => updateScopeNotice(session));
        }
        close.addEventListener('click', () => requestCloseEditor(session));
        cancel.addEventListener('click', () => requestCloseEditor(session));
        save.addEventListener('click', () => saveEditor(session));
        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) requestCloseEditor(session);
        });
        textarea.focus();
    }

    // ══════ API 請求：直連與代發 ══════

    const REQUEST_TIMEOUT_MS = 300000;

    // Every message this can throw names the thing the user has to go and do. "尚未設定
    // API" with no more than that is the version 0.8.0 shipped for a missing profile, and
    // it left people hunting through SillyTavern's own settings for a switch that was
    // never there.
    function requireApiConfig(action) {
        const config = resolveApiConfig(state.settings, action);
        if (!config) throw new Error('還沒有可用的 API 設定。請到設定的「API 設定」分頁新增一組，填入網址、金鑰與模型。');
        if (!config.endpoint) throw new Error(`API 設定「${config.name}」還沒填網址。`);
        if (!config.apiKey) throw new Error(`API 設定「${config.name}」還沒填 API 金鑰。設定代碼為了安全不含金鑰，換版本之後要再貼一次。`);
        if (!config.model) throw new Error(`API 設定「${config.name}」還沒填模型。可以按「載入模型」挑一個，或直接打上去。`);
        return config;
    }

    function requestBody(config, messages, stream) {
        const body = {
            // ⚠️ Extras first so the known fields always win. sanitizeExtraBody already
            // strips the reserved keys, so this cannot matter today — it is here so that
            // it still cannot matter if that list is ever widened by mistake.
            ...config.extraBody,
            model: config.model,
            messages,
            max_tokens: config.maxTokens,
            stream: Boolean(stream),
        };
        // Blank temperature means the parameter is left out entirely — some models
        // refuse the request outright when it is present.
        if (config.temperature !== null) body.temperature = config.temperature;
        return body;
    }

    function directHeaders(config) {
        return { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` };
    }

    async function readResponseError(response) {
        const detail = await response.text().catch(() => '');
        const error = new Error(detail.slice(0, 300));
        error.status = response.status;
        return error;
    }

    // The backend-forward path: SillyTavern's own server makes the call, so the browser
    // never talks to the third party and CORS cannot apply. Same endpoint, same key —
    // this is not a Connection Profile and does not touch the user's active connection.
    //
    // ⚠️ ST's backend appends /chat/completions to custom_url itself, so the suffix is
    // stripped here. Getting that wrong sends the request somewhere the user never typed.
    function backendPayload(config, messages, stream) {
        const url = endpointChatUrl(config.endpoint).replace(/\/chat\/completions$/, '');
        const payload = {
            chat_completion_source: 'custom',
            custom_url: url,
            // Must be a string: the backend runs it through a YAML parse, and JSON is
            // valid YAML.
            custom_include_headers: JSON.stringify({ Authorization: `Bearer ${config.apiKey}` }),
            model: config.model,
            messages,
            max_tokens: config.maxTokens,
            stream: Boolean(stream),
        };
        if (config.temperature !== null) payload.temperature = config.temperature;
        // ⚠️ Extra parameters CANNOT ride along as loose keys on this path, and this is
        // the whole reason the two paths are built separately instead of one being
        // derived from the other. Verified in SillyTavern's source: for
        // chat_completion_source 'custom' the server builds the upstream body from named
        // fields only, then merges `custom_include_body` into it
        // (mergeObjectWithYaml(bodyParams, request.body.custom_include_body)). A stray
        // `reasoning` key sitting at the top level is simply dropped — the request still
        // succeeds, reasoning is still on, and nothing anywhere says why.
        if (Object.keys(config.extraBody).length) {
            payload.custom_include_body = JSON.stringify(config.extraBody);
        }
        return payload;
    }

    function backendService() {
        const service = getContext()?.ChatCompletionService;
        if (typeof service?.processRequest !== 'function') {
            throw new Error(`你的 SillyTavern 版本沒有這個轉送功能。請把「${BACKEND_SWITCH_LABEL}」取消勾選，或升級 SillyTavern。`);
        }
        return service;
    }

    async function sendViaBackend(config, messages, signal, onText) {
        const service = backendService();
        const stream = config.stream;
        const result = await service.processRequest(backendPayload(config, messages, stream), { presetName: undefined }, true, signal);
        if (!stream) return String(result?.content ?? '');
        const iterator = typeof result === 'function' ? result() : result;
        let text = '';
        for await (const chunk of iterator) {
            // Same contract as ConnectionManagerRequestService: each chunk carries the
            // whole text so far, not the delta. `=` is not a missing `+=`.
            text = String(chunk?.text ?? text);
            onText(text);
        }
        return text;
    }

    async function sendDirect(config, messages, signal, onText) {
        const response = await hostWindow.fetch(endpointChatUrl(config.endpoint), {
            method: 'POST',
            headers: directHeaders(config),
            body: JSON.stringify(requestBody(config, messages, config.stream)),
            signal,
        });
        if (!response.ok) throw await readResponseError(response);
        if (!config.stream) {
            const data = await response.json();
            return String(data?.choices?.[0]?.message?.content ?? '');
        }
        return readEventStream(response, onText);
    }

    // ⚠️ Some relays answer `stream: true` with an ordinary completion instead of an
    // event stream. Scanning that for `data:` lines finds nothing, and an empty reply
    // reads upstream as "the model said nothing" — the whole scope then gets replaced by
    // a fallback nobody asked for. Whatever was collected is re-read as a plain body
    // before giving up.
    async function readEventStream(response, onText) {
        const reader = response.body?.getReader?.();
        if (!reader) return extractNonStreamContent(await response.text());
        const decoder = new hostWindow.TextDecoder();
        let buffer = '';
        let raw = '';
        let text = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const piece = decoder.decode(value, { stream: true });
            raw += piece;
            buffer += piece;
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                const payload = line.replace(/^data:\s*/, '').trim();
                if (!payload || payload === line.trim() || payload === '[DONE]') continue;
                try {
                    const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
                    if (typeof delta === 'string' && delta) {
                        text += delta;
                        onText(text);
                    }
                } catch {
                    // A partial or non-JSON event is not fatal; the stream carries on.
                }
            }
        }
        if (text) return text;
        const fallback = extractNonStreamContent(raw);
        if (fallback) onText(fallback);
        return fallback;
    }

    async function generateWithApi(request, dialog) {
        const controller = new hostWindow.AbortController();
        let stopped = false;
        dialog.setStopHandler(() => {
            stopped = true;
            controller.abort();
        });
        const timer = hostWindow.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const send = request.config.viaBackend ? sendViaBackend : sendDirect;
            const text = await send(request.config, request.messages, controller.signal, value => dialog.updateStream(value));
            return { text, stopped };
        } catch (error) {
            if (stopped) return { text: '', stopped: true };
            // Rethrown with a sentence that says what to do about it. The raw error stays
            // on the console; a bare "Failed to fetch" in the dialog helps nobody.
            const described = new Error(describeRequestError(error, request.config.viaBackend));
            described.cause = error;
            throw described;
        } finally {
            hostWindow.clearTimeout(timer);
        }
    }

    // Asks the provider what it can run. It doubles as the only connection test there
    // is, but ⚠️ it is a thermometer, not a lock: /models and /chat/completions are two
    // different addresses whose permissions can differ, so a failure here never stops
    // the user saving the group or typing a model name by hand (ADR-0005).
    async function fetchApiModels(config) {
        const controller = new hostWindow.AbortController();
        const timer = hostWindow.setTimeout(() => controller.abort(), 20000);
        try {
            // Must travel the same road as a real request. A models call that always went
            // direct would report failure on a connection that works, because the switch
            // that fixes it was never applied here.
            if (config.viaBackend) {
                const service = getContext();
                if (typeof service?.getRequestHeaders !== 'function') {
                    throw new Error('你的 SillyTavern 版本沒辦法幫忙轉送模型清單的請求。模型名稱請自己打上去。');
                }
                const response = await hostWindow.fetch('/api/backends/chat-completions/status', {
                    method: 'POST',
                    headers: service.getRequestHeaders(),
                    body: JSON.stringify({
                        chat_completion_source: 'custom',
                        custom_url: endpointModelsUrl(config.endpoint).replace(/\/models$/, ''),
                        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${config.apiKey}` }),
                    }),
                    signal: controller.signal,
                });
                if (!response.ok) throw await readResponseError(response);
                const data = await response.json();
                // ⚠️ This route does not fail with a status code: an upstream error comes
                // back as 200 with { error: true }.
                if (data?.error) throw new Error('酒館的伺服器送不出去。請核對網址與金鑰；詳細原因會出現在酒館伺服器的主控台。');
                return extractModelIds(data);
            }
            const response = await hostWindow.fetch(endpointModelsUrl(config.endpoint), {
                method: 'GET',
                headers: directHeaders(config),
                signal: controller.signal,
            });
            if (!response.ok) throw await readResponseError(response);
            return extractModelIds(await response.json());
        } finally {
            hostWindow.clearTimeout(timer);
        }
    }

    // ══════ 差異視窗與審核流程 ══════

    function paintWordDiff(container, ops, side) {
        let appended = false;
        for (const op of ops) {
            if (op.type === 'equal' || (side === 'original' && op.type === 'remove') || (side === 'proposed' && op.type === 'add')) {
                const span = createElement('span', op.type === 'remove' ? 'stiae-word-removed' : op.type === 'add' ? 'stiae-word-added' : '');
                span.textContent = op.value;
                container.append(span);
                appended = true;
            }
        }
        if (!appended) container.append(hostDocument.createTextNode(' '));
    }

    // Both sides of a row are painted from ONE op list. They differ only in which ops
    // they keep, so running the word-level LCS once per side would pay the same DP
    // twice for an identical result — and that DP runs on the SillyTavern tab's main
    // thread, which is why lcsOps carries a cell limit at all.
    function buildDiffRowCells(row) {
        const original = createElement('div', 'stiae-diff-cell original');
        const proposed = createElement('div', 'stiae-diff-cell proposed');
        if (row.type === 'equal') {
            original.textContent = row.original;
            proposed.textContent = row.proposed;
            return [original, proposed];
        }
        const ops = lcsOps(tokenizeForDiff(row.original), tokenizeForDiff(row.proposed), (a, b) => a === b, 80000);
        if (row.addOnly) {
            original.classList.add('stiae-diff-empty');
            original.textContent = ' ';
        } else {
            original.classList.add('removed');
            paintWordDiff(original, ops, 'original');
        }
        if (row.removeOnly) {
            proposed.classList.add('stiae-diff-empty');
            proposed.textContent = ' ';
        } else {
            proposed.classList.add('added');
            paintWordDiff(proposed, ops, 'proposed');
        }
        return [original, proposed];
    }

    // A row-major grid rather than two independently built columns. Two things need
    // the sides to share a grid row: the checkbox in the left gutter has to stay level
    // with the change it governs, and the two sides no longer drift apart when a long
    // line wraps to a different height on one side only.
    //
    // Takes rows rather than the two texts: the interactive caller already holds the
    // rows it composes from, and letting it pass texts *as well* would allow a view
    // that renders one diff while the accept button writes another.
    //
    // `selection` is optional — without it there is no gutter and no checkboxes, which
    // is what the read-only full-floor preview wants.
    function buildDiffView(rows, options = {}) {
        const { selection = null, onChange = null } = options;
        const wrapper = createElement('div');
        const grid = createElement('div', `stiae-diff-grid${selection ? ' stiae-has-gate' : ''}`);
        grid.dataset.active = 'proposed';
        if (selection) grid.append(createElement('div', 'stiae-diff-title stiae-diff-gate', '採用'));
        grid.append(
            createElement('div', 'stiae-diff-title original', '原文'),
            createElement('div', 'stiae-diff-title proposed', '修改後'),
        );
        rows.forEach((row, index) => {
            const cells = buildDiffRowCells(row);
            // One checkbox per changed row, so a row carrying two patches is governed
            // as one decision. That is the deliberate trade for applying the patches
            // exactly once — see composeSelectedRows.
            if (selection) {
                const gate = createElement('div', 'stiae-diff-gate');
                cells.unshift(gate);
                if (row.type !== 'equal') {
                    const box = createElement('input', 'stiae-diff-checkbox');
                    box.type = 'checkbox';
                    box.checked = selection[index] !== false;
                    box.title = '取消勾選就保留這一行的原文';
                    const paint = () => cells.forEach(cell => cell.classList.toggle('stiae-diff-off', !box.checked));
                    box.addEventListener('change', () => {
                        selection[index] = box.checked;
                        paint();
                        onChange?.();
                    });
                    gate.append(box);
                    paint();
                }
            }
            grid.append(...cells);
        });
        // Always built. The stylesheet shows them only on a narrow screen, where one
        // side has to be hidden for anything to be readable — including in the
        // read-only preview, which previously had no way to switch and so rendered
        // both sides interleaved line by line under two stacked headers.
        const tabs = createElement('div', 'stiae-diff-tabs');
        const originalTab = button('原文');
        const proposedTab = button('修改後', '', 'stiae-primary');
        originalTab.addEventListener('click', () => {
            grid.dataset.active = 'original';
            originalTab.classList.add('stiae-primary');
            proposedTab.classList.remove('stiae-primary');
        });
        proposedTab.addEventListener('click', () => {
            grid.dataset.active = 'proposed';
            proposedTab.classList.add('stiae-primary');
            originalTab.classList.remove('stiae-primary');
        });
        tabs.append(originalTab, proposedTab);
        wrapper.append(tabs, grid);
        return wrapper;
    }

    // Answers a different question from the editor's own reference panel. That one is
    // "what am I about to pay for"; this one is "the result looks wrong — what did the
    // model actually see". The full request only exists once a command has been
    // pressed, because only then is the instruction, the editing principles and the
    // protocol known, which is why it cannot live in the editor.
    //
    // ⚠️ Collapsed, never a gate, and it must stay inside the modal. The review dialog
    // covers the screen because scope.start / scope.end were frozen before the request
    // went out; letting this grow into a side panel over a usable textarea would let
    // those offsets go stale and land the result in the wrong place.
    function buildRequestPreview(messages) {
        const rows = messages || [];
        const size = rows.reduce((total, message) => total + String(message?.content ?? '').length, 0);
        const details = createElement('details', 'stiae-request-preview');
        details.append(createElement('summary', '', `查看這次送出的完整請求（${size.toLocaleString('en-US')} 字元）`));
        for (const message of rows) {
            details.append(createElement('div', 'stiae-request-role', MESSAGE_ROLE_LABELS[message.role] || message.role));
            details.append(createElement('pre', 'stiae-request-body', String(message?.content ?? '')));
        }
        return details;
    }

    function createReviewDialog(action, scope, messages) {
        const overlay = createElement('div', `${ROOT_CLASS} stiae-overlay stiae-review-layer`);
        const modal = createElement('section', 'stiae-modal stiae-review-modal');
        const header = createElement('header', 'stiae-header');
        header.append(createElement('strong', '', `檢查修改 · ${action.name}`));
        const close = createElement('button', 'stiae-close', '×');
        close.type = 'button';
        header.append(close);
        const body = createElement('div', 'stiae-review-body');
        const status = createElement('div', 'stiae-status');
        const warnings = createElement('div');
        const content = createElement('div');
        // Built once and left in place: regenerating reuses the same request, and the
        // three view states below only ever replace `warnings` and `content`.
        body.append(status, buildRequestPreview(messages), warnings, content);
        const footer = createElement('footer', 'stiae-footer');
        const copyRaw = button('複製原始輸出', 'fa-copy');
        const stop = button('停止', 'fa-stop', 'stiae-danger');
        const reject = button('拒絕', 'fa-xmark');
        const regenerate = button('重新生成', 'fa-rotate-right');
        const accept = button('接受修改', 'fa-check', 'stiae-primary');
        footer.append(copyRaw, stop, reject, regenerate, accept);
        modal.append(header, body, footer);
        overlay.append(modal);
        hostDocument.body.append(overlay);

        let resolver = null;
        let pendingAction = null;
        let rawText = '';
        let stopHandler = null;
        let closed = false;
        let selection = [];
        let resultText = '';

        const emit = actionName => {
            if (!resolver) {
                pendingAction = actionName;
                return;
            }
            const resolve = resolver;
            resolver = null;
            resolve(actionName);
        };

        // The diff rows are computed once, from the result of applying every patch,
        // and never recomputed while the user ticks. That is the whole point of
        // selecting at the row layer: the patches have already run, so no tick can
        // change whether one of them matched. Only the composed text, the counter and
        // the accept button move.
        let diffRows = [];
        let changedCount = 0;
        let previewBody = null;
        let previewStale = true;
        // Survives renderResult, which builds a fresh <details> per generation. Without
        // it, hitting 重新生成 collapses a preview the user had deliberately opened —
        // exactly when they want to see the new result in context.
        let previewOpen = false;

        const renderPreview = () => {
            if (!previewBody) return;
            previewBody.replaceChildren(buildDiffView(
                computeDiffRows(scope.fullText, applyScope(scope.fullText, scope.start, scope.end, resultText)),
            ));
            previewStale = false;
        };

        // Runs on every tick, so it does the least it can. It does not touch the diff
        // grid — the rows are unchanged and buildDiffView repaints the ticked row's own
        // cells — and it only marks the full-floor preview dirty. Rebuilding that
        // eagerly would run a whole-message LCS per click, including while the
        // <details> is collapsed and nobody can see it.
        const refreshComposed = () => {
            resultText = composeSelectedRows(diffRows, selection);
            const kept = selection.filter(Boolean).length;
            status.textContent = changedCount
                ? `共 ${changedCount} 處變更，已採用 ${kept} 處。`
                : '模型沒有改動任何內容。';
            accept.classList.toggle('stiae-hidden', resultText === scope.text);
            previewStale = true;
            if (previewBody?.parentElement?.open) renderPreview();
        };

        const renderResult = parsed => {
            diffRows = computeDiffRows(scope.text, parsed.text);
            // Every changed row starts ticked: the model was asked for these, so the
            // user's job is to veto, not to opt in one at a time. Equal rows stay
            // false, which is what lets `kept` above be a plain truthy count.
            selection = diffRows.map(row => row.type !== 'equal');
            changedCount = selection.filter(Boolean).length;
            // Warnings describe what the model returned, not what is ticked, so they
            // are written once and left alone.
            warnings.replaceChildren();
            for (const warningText of parsed.warnings) warnings.append(createElement('div', 'stiae-warning', warningText));
            content.replaceChildren(buildDiffView(diffRows, { selection, onChange: refreshComposed }));
            previewBody = null;
            if (scope.hasSelection) {
                const details = createElement('details', 'stiae-full-preview');
                details.append(createElement('summary', '', '查看整個樓層的修改位置'));
                previewBody = createElement('div');
                details.append(previewBody);
                details.addEventListener('toggle', () => {
                    previewOpen = details.open;
                    if (details.open && previewStale) renderPreview();
                });
                details.open = previewOpen;
                content.append(details);
            }
            refreshComposed();
        };

        const api = {
            setStopHandler(handler) { stopHandler = handler; },
            waitAction() {
                if (pendingAction) {
                    const actionName = pendingAction;
                    pendingAction = null;
                    return Promise.resolve(actionName);
                }
                return new Promise(resolve => { resolver = resolve; });
            },
            showGenerating() {
                rawText = '';
                status.textContent = '正在生成；完成後才會建立差異。';
                warnings.replaceChildren();
                const stream = createElement('pre', 'stiae-stream', '等待模型輸出…');
                content.replaceChildren(stream);
                api.streamElement = stream;
                stop.classList.remove('stiae-hidden');
                copyRaw.classList.add('stiae-hidden');
                regenerate.classList.add('stiae-hidden');
                accept.classList.add('stiae-hidden');
            },
            updateStream(text) {
                rawText = String(text ?? '');
                if (api.streamElement) api.streamElement.textContent = rawText || '等待模型輸出…';
            },
            showResult(parsed) {
                rawText = parsed.raw;
                renderResult(parsed);
                stop.classList.add('stiae-hidden');
                copyRaw.classList.remove('stiae-hidden');
                regenerate.classList.remove('stiae-hidden');
            },
            resultText() { return resultText; },
            showError(message, stopped = false) {
                status.textContent = stopped ? '生成已停止。已產生的文字只供複製，不能套用。' : '生成失敗。';
                warnings.replaceChildren(createElement('div', 'stiae-warning', message));
                if (!rawText) content.replaceChildren(createElement('pre', 'stiae-stream', '沒有可用輸出。'));
                stop.classList.add('stiae-hidden');
                copyRaw.classList.toggle('stiae-hidden', !rawText);
                regenerate.classList.remove('stiae-hidden');
                accept.classList.add('stiae-hidden');
            },
            close() {
                if (closed) return;
                closed = true;
                overlay.remove();
                if (state.activeReview === api) state.activeReview = null;
            },
        };

        copyRaw.addEventListener('click', async () => {
            try {
                await hostWindow.navigator.clipboard.writeText(rawText);
                toast('success', '已複製模型原始輸出。');
            } catch {
                tavern.builtin?.copyText?.(rawText);
            }
        });
        stop.addEventListener('click', () => stopHandler?.());
        reject.addEventListener('click', () => emit('reject'));
        regenerate.addEventListener('click', () => emit('regenerate'));
        accept.addEventListener('click', () => emit('accept'));
        close.addEventListener('click', () => {
            stopHandler?.();
            emit('reject');
        });
        state.activeReview = api;
        return api;
    }

    async function runAiAction(session, actionInput) {
        if (!session || state.activeEditor !== session || state.activeReview) return;
        closeDetailsMenus(session.toolbar);
        const action = {
            ...actionInput,
            mode: actionInput.mode === 'replacement' ? 'replacement' : 'patch',
            apiConfigId: actionInput.apiConfigId || '',
        };
        const scope = scopeFromTextarea(session.textarea);
        if (!scope.text.length) {
            toast('warning', '可編輯範圍是空的。');
            return;
        }

        let config;
        try {
            config = requireApiConfig(action);
        } catch (error) {
            toast('error', error.message);
            openSettings('api');
            return;
        }

        // Rebuilt here rather than read off the session: the echo list is debounced, so
        // a command pressed straight after typing would otherwise send the previous
        // range. What goes out has to match what the user just looked at.
        const reference = await refreshReference(session);
        if (state.activeEditor !== session || state.activeReview) return;

        const request = {
            config,
            messages: buildPrompt(action, scope, session.role, {
                referenceBlock: reference.block,
                cards: resolvePromptCards(state.settings, actionInput),
            }),
        };
        const dialog = createReviewDialog(action, scope, request.messages);

        while (state.activeReview === dialog) {
            dialog.showGenerating();
            let response;
            try {
                response = await generateWithApi(request, dialog);
            } catch (error) {
                const stopped = error?.name === 'AbortError' || error?.cause?.name === 'AbortError';
                // The dialog only has room for the short message, and a bare status code
                // says nothing about why the provider refused. Keep the whole error where
                // it can be read.
                if (!stopped) console.error('[ST Inline AI Editor] Generation failed.', error, error?.cause);
                // ⚠️ `error.message` first, `cause` only as a fallback. generateWithApi
                // has already turned the raw failure into a sentence that says what to do
                // about it, and the original is kept on `cause` for the console. Reading
                // cause first — which is what 0.8.0 did, because the profile service
                // wrapped errors the other way round — puts a bare "Failed to fetch" on
                // screen and buries the one line telling the user to tick 代發.
                dialog.showError(stopped ? '請重新生成或關閉視窗。' : (error?.message || error?.cause?.message || 'API 請求失敗。'), stopped);
                const decision = await dialog.waitAction();
                if (decision === 'regenerate') continue;
                dialog.close();
                return;
            }

            if (response.stopped) {
                dialog.showError('請重新生成或關閉視窗。', true);
                const decision = await dialog.waitAction();
                if (decision === 'regenerate') continue;
                dialog.close();
                return;
            }

            if (!response.text.trim()) {
                dialog.showError('模型沒有傳回任何文字。');
                const decision = await dialog.waitAction();
                if (decision === 'regenerate') continue;
                dialog.close();
                return;
            }

            const parsed = parseAiResponse(response.text, action.mode, scope.text, Boolean(reference.block));
            dialog.showResult(parsed);
            const decision = await dialog.waitAction();
            if (decision === 'regenerate') continue;
            if (decision === 'accept') {
                // Read off the dialog, not off `parsed`: the ticked subset is what
                // the user just looked at, and `parsed.text` is only the all-ticked
                // case. Must happen before dialog.close().
                const acceptedText = dialog.resultText();
                session.textarea.focus();
                session.textarea.setSelectionRange(scope.start, scope.end);
                session.textarea.setRangeText(acceptedText, scope.start, scope.end, 'select');
                session.textarea.dispatchEvent(new hostWindow.Event('input', { bubbles: true }));
                session.draft = session.textarea.value;
                updateScopeNotice(session);
                toast('success', '修改已加入草稿，尚未寫入樓層。');
            }
            dialog.close();
            return;
        }
    }

    // ══════ 更新：檢查與寫回腳本庫 ══════

    // Why this can work at all: TavernHelper 4.8.0 added getScriptTrees /
    // updateScriptTreesWith, so a script can find itself in the library and replace its
    // own content. The script is not deleted and recreated, so its script_id survives —
    // and because settings are script variables keyed by that id, they survive with it.
    // That is the entire point: importing a new copy has always meant starting empty.
    //
    // ⚠️ TavernHelper's own annotation for ScriptTreesOptions contradicts itself (the
    // prose says 'chat'/'preset'/'global', the type says 'global'/'preset'/'character'),
    // so all three are asked rather than betting on one. Betting wrong would mean writing
    // the new source into a list this script is not in.
    const SCRIPT_TREE_TYPES = ['global', 'preset', 'character'];
    const UPDATE_TIMEOUT_MS = 15000;

    function scriptUpdateApiAvailable() {
        return typeof tavern.getScriptTrees === 'function'
            && typeof tavern.updateScriptTreesWith === 'function'
            && typeof globalScope.getScriptId === 'function';
    }

    // Returns { type, selfId } or null. Folders hold scripts one level down, which is the
    // only nesting the ScriptTree type allows.
    function findSelfInScriptTrees() {
        if (!scriptUpdateApiAvailable()) return null;
        const selfId = globalScope.getScriptId();
        if (!selfId) return null;
        for (const type of SCRIPT_TREE_TYPES) {
            let trees;
            try {
                trees = tavern.getScriptTrees({ type });
            } catch {
                continue;
            }
            const holdsSelf = (trees || []).some(node => (node?.type === 'folder'
                ? (node.scripts || []).some(script => script?.id === selfId)
                : node?.id === selfId));
            if (holdsSelf) return { type, selfId };
        }
        return null;
    }

    async function fetchUpdateSource() {
        const controller = new hostWindow.AbortController();
        const timer = hostWindow.setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
        try {
            // ⚠️ Measured 2026-08-11: raw.githubusercontent answers `cache-control:
            // max-age=300` from a Fastly edge that ignores BOTH a `?t=` query string and a
            // `Cache-Control: no-cache` request header. So neither of these actually
            // defeats it — for up to five minutes after a release, a check can still
            // report the previous version. They are kept because they do work on ordinary
            // intermediate caches (corporate proxies, service workers); do not write a
            // comment claiming they beat GitHub's CDN, because they do not.
            const response = await hostWindow.fetch(`${UPDATE_SOURCE_URL}?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
            // 404 has one overwhelmingly likely cause and it is not "the file moved":
            // raw.githubusercontent serves nothing at all for a private repository, so a
            // repo that is private (or has been made private again) answers 404 to
            // everyone. Saying only "HTTP 404" sends the reader hunting for a typo.
            if (!response.ok) {
                throw new Error(response.status === 404
                    ? '抓不到更新來源（HTTP 404）。最常見的原因是那個 GitHub repo 是私有的——私有 repo 的公開網址對誰都是 404。'
                    : `HTTP ${response.status}`);
            }
            return await response.text();
        } finally {
            hostWindow.clearTimeout(timer);
        }
    }

    function updateAvailable() {
        const latest = state.update.latest || state.settings.updateLatestVersion;
        return Boolean(latest) && compareVersions(latest, VERSION) > 0;
    }

    // Only ever runs because the user pressed 檢查更新. Nothing schedules this.
    async function checkForUpdate() {
        if (state.update.checking) return;
        state.update.checking = true;
        state.update.error = '';
        renderUpdateSection();
        try {
            const source = await fetchUpdateSource();
            const inspected = inspectUpdateSource(source, VERSION);
            if (!inspected.ok) throw new Error(inspected.error);
            state.update.latest = inspected.version;
            state.update.checked = true;
            // Lifted from the copy just downloaded, so the notes on screen describe the
            // version being offered rather than the one already installed. Deliberately
            // not persisted: it belongs to a version that is not running here, and a
            // stale copy of it after an update would describe changes already applied.
            state.update.changelog = readChangelogFromSource(source);
            state.settings.updateLatestVersion = inspected.version;
            saveSettings();
            toast(inspected.newer ? 'success' : 'info', inspected.newer
                ? `有新版本 ${inspected.version}（目前 ${VERSION}）。`
                : `已經是最新版本（${VERSION}）。`);
        } catch (error) {
            console.warn('[ST Inline AI Editor] Update check failed.', error);
            state.update.error = String(error?.message || error);
            toast('error', `檢查更新失敗：${state.update.error}`);
        } finally {
            state.update.checking = false;
            renderUpdateSection();
            if (state.activeEditor) markToolbarUpdateBadge(state.activeEditor);
        }
    }

    // ⚠️ This call ends this script's life. Verified against TavernHelper's source
    // (src/function/script.ts, src/store/iframe_runtimes/script.ts, src/panel/Script.vue):
    // replaceScriptTrees writes into the Pinia store, the `runtimes` computed carries
    // `content`, and <Iframe :content> turns it into the iframe's srcdoc — so changing
    // content reloads the iframe immediately. That is exactly what we want (no page
    // refresh needed), but it means **nothing after this call can be relied on**: dialogs
    // are drawn by this realm, and this realm is about to be replaced.
    //
    // So: ask everything before, and afterwards only toast() — toastr lives in the parent
    // window and outlives us.
    async function writeSelfSource(location, source) {
        await tavern.updateScriptTreesWith(trees => (trees || []).map(node => {
            if (node?.type === 'folder') {
                return { ...node, scripts: (node.scripts || []).map(script => (script?.id === location.selfId ? { ...script, content: source } : script)) };
            }
            return node?.id === location.selfId ? { ...node, content: source } : node;
        }), { type: location.type });
    }

    // Downloads again rather than reusing whatever the check saw, so the version named in
    // the confirmation is the version actually about to be written. The check can be
    // hours old by now.
    async function runUpdate() {
        if (state.update.installing) return;
        const location = findSelfInScriptTrees();
        if (!location) {
            toast('error', '在酒館助手的腳本庫裡找不到這支腳本，無法自動更新。請改用手動匯入。');
            return;
        }
        state.update.installing = true;
        renderUpdateSection();
        let source;
        let version;
        try {
            source = await fetchUpdateSource();
            const inspected = inspectUpdateSource(source, VERSION);
            if (!inspected.ok) throw new Error(inspected.error);
            version = inspected.version;
            if (!inspected.newer) {
                toast('info', `遠端版本是 ${version}，不比目前的 ${VERSION} 新，沒有更新。`);
                return;
            }
        } catch (error) {
            console.error('[ST Inline AI Editor] Could not fetch the update.', error);
            toast('error', `抓取新版失敗：${String(error?.message || error)}。目前的腳本沒有被動到。`);
            return;
        } finally {
            state.update.installing = false;
            renderUpdateSection();
        }

        // ⚠️ Everything the user must be told has to be said HERE, before the write.
        // Writing the new source makes TavernHelper reload this very script, and this
        // script is what draws the dialogs — see the note above writeSelfSource().
        const editor = state.activeEditor;
        const unsaved = editor && editor.textarea.value !== editor.baseText
            ? `\n\n⚠️ 第 ${editor.messageId} 樓的編輯器有還沒儲存的修改，重新載入會讓它消失。要先存檔就按取消。`
            : '';
        const confirmed = await showConfirm(
            `要把這支腳本從 ${VERSION} 換成 ${version} 嗎？\n\n`
            + '換的是腳本庫裡這一支的內容，不是新增一份，所以你的設定全部留著：API 設定（含金鑰）、提示詞模組、內建指令的修改、客製指令與分組、世界書勾選。\n\n'
            + '換完之後酒館助手會自己重新載入這個腳本，開著的編輯器與設定視窗會關閉。'
            + unsaved,
            { confirmLabel: `更新到 ${version}`, danger: Boolean(unsaved) },
        );
        if (!confirmed) return;

        try {
            await writeSelfSource(location, source);
        } catch (error) {
            console.error('[ST Inline AI Editor] Could not write the update.', error);
            toast('error', `寫入新版失敗：${String(error?.message || error)}。目前的腳本沒有被動到。`);
            return;
        }
        // toastr belongs to the parent window, so this survives our own iframe being torn
        // down — unlike a dialog, which is drawn by the code that is about to stop
        // existing. The fallback sentence covers a host that does not reload on its own;
        // saying "已完成" with no way to tell would be the worse failure.
        toast('success', `已更新到 ${version}。腳本正在重新載入——若過幾秒沒有反應，重新整理頁面即可。`);
    }

    function renderUpdateSection() {
        state.updateRender?.();
    }

    // A dot on the settings button, because that is where the update lives. Nothing else
    // in the editor changes — an update is never urgent enough to interrupt an edit.
    function markToolbarUpdateBadge(session) {
        session?.settingsButton?.classList.toggle('stiae-has-update', updateAvailable());
    }

    // ══════ 表單與設定視窗 ══════

    function showSimpleForm(title, buildContent, onSubmit) {
        return new Promise(resolve => {
            const overlay = createElement('div', `${ROOT_CLASS} stiae-overlay stiae-sub-layer`);
            const modal = createElement('section', 'stiae-settings-modal');
            const header = createElement('header', 'stiae-header');
            header.append(createElement('strong', '', title));
            const close = createElement('button', 'stiae-close', '×');
            close.type = 'button';
            header.append(close);
            const form = createElement('form', 'stiae-settings-body');
            form.id = makeId('form');
            buildContent(form);
            const footer = createElement('footer', 'stiae-footer');
            const cancel = button('取消', 'fa-xmark');
            const submit = button('確定', 'fa-check', 'stiae-primary');
            submit.type = 'submit';
            // The footer sits outside <form>, so the submit button must be associated explicitly.
            submit.setAttribute('form', form.id);
            footer.append(cancel, submit);
            modal.append(header, form, footer);
            overlay.append(modal);
            hostDocument.body.append(overlay);

            const finish = value => {
                overlay.remove();
                resolve(value);
            };
            close.addEventListener('click', () => finish(null));
            cancel.addEventListener('click', () => finish(null));
            form.addEventListener('submit', event => {
                event.preventDefault();
                const result = onSubmit(form);
                if (result !== undefined) finish(result);
            });
        });
    }

    async function showOneOffCommand(session) {
        return showSimpleForm('臨時指令', form => {
            const instructionField = createElement('div', 'stiae-field');
            instructionField.append(createElement('label', '', '指示'));
            const instruction = createElement('textarea');
            instruction.name = 'instruction';
            instruction.required = true;
            instruction.placeholder = '例如：把對話改得更含蓄，但不要改變事件。';
            instruction.value = session.oneOffInstruction;
            instructionField.append(instruction);
            const modeField = createElement('div', 'stiae-field');
            modeField.append(createElement('label', '', '編輯模式'));
            const mode = createElement('select');
            mode.name = 'mode';
            [['patch', '局部修補（search / replace）'], ['replacement', '全文改寫（replacement）']].forEach(([value, label]) => {
                const option = createElement('option', '', label);
                option.value = value;
                mode.append(option);
            });
            mode.value = state.settings.lastCustomMode;
            modeField.append(mode);
            form.append(instructionField, modeField);
            hostWindow.setTimeout(() => instruction.focus(), 0);
        }, form => {
            const instruction = form.elements.instruction.value.trim();
            if (!instruction) return undefined;
            const mode = form.elements.mode.value === 'replacement' ? 'replacement' : 'patch';
            state.settings.lastCustomMode = mode;
            saveSettings();
            session.oneOffInstruction = instruction;
            return { id: 'one-off', name: '臨時指令', icon: 'fa-comment-dots', instruction, mode };
        });
    }

    // Returns the new name, or null if cancelled. Blank is refused — an empty name would
    // silently mean "ungroup everything in here", which is what 解散 is for.
    function showGroupNameForm(current, existingNames) {
        return showSimpleForm('重新命名分組', form => {
            const field = createElement('div', 'stiae-field');
            field.append(createElement('label', '', '分組名稱'));
            const input = createElement('input');
            input.name = 'name';
            input.required = true;
            input.value = current;
            const others = existingNames.filter(name => name !== current);
            field.append(input, createElement(
                'div',
                'stiae-help',
                others.length
                    ? `改成既有的名字會把兩組併在一起。目前的其他分組：${others.join('、')}。`
                    : '這是目前唯一的分組。',
            ));
            form.append(field);
            hostWindow.setTimeout(() => { input.focus(); input.select(); }, 0);
        }, form => {
            const name = form.elements.name.value.trim();
            if (!name) return undefined;
            return name;
        });
    }

    // The select carries existing groups; 建立新分組 reveals a text field beside it. The
    // builtin form has neither, and that is not the same as choosing 不分組 — it means
    // "leave whatever was there alone".
    function readGroupFromForm(form, fallback) {
        const select = form.elements.group;
        if (!select) return fallback;
        if (select.selectedOptions[0]?.dataset.new === '1') return String(form.elements.newGroup?.value ?? '').trim();
        return select.value;
    }

    async function showApiConfigForm(existing) {
        const config = existing ? clone(existing) : normalizeApiConfig({ name: '' }, state.settings.apiConfigs.length);
        return showSimpleForm(existing ? '編輯 API 設定' : '新增 API 設定', form => {
            const nameField = createElement('div', 'stiae-field');
            nameField.append(createElement('label', '', '名稱'));
            const name = createElement('input');
            name.name = 'name';
            name.required = true;
            name.value = existing ? config.name : '';
            name.placeholder = '例如：OpenRouter 主力';
            nameField.append(name);

            const endpointField = createElement('div', 'stiae-field');
            endpointField.append(createElement('label', '', 'API 網址'));
            const endpoint = createElement('input');
            endpoint.name = 'endpoint';
            endpoint.required = true;
            endpoint.value = config.endpoint;
            endpoint.placeholder = 'https://openrouter.ai/api/v1';
            endpointField.append(endpoint, createElement(
                'div',
                'stiae-help',
                'AI 服務商給你的網址，通常長得像 https://openrouter.ai/api/v1。⚠ 這裡填什麼就用什麼，工具不會幫你猜、也不會自動補東西——請照服務商文件上寫的完整複製過來（多數要以 /v1 結尾）。',
            ));

            const keyField = createElement('div', 'stiae-field');
            keyField.append(createElement('label', '', 'API 金鑰'));
            const apiKey = createElement('input');
            apiKey.name = 'apiKey';
            apiKey.type = 'password';
            apiKey.value = config.apiKey;
            apiKey.placeholder = 'sk-…';
            keyField.append(apiKey, createElement(
                'div',
                'stiae-help',
                '服務商給你的那串密碼，通常以 sk- 開頭。⚠ 為了安全，它不會被放進「複製設定代碼」裡——換版本或換電腦之後要再貼一次。',
            ));

            const modelField = createElement('div', 'stiae-field');
            modelField.append(createElement('label', '', '模型'));
            const model = createElement('input');
            model.name = 'model';
            model.required = true;
            model.value = config.model;
            model.placeholder = 'openai/gpt-4o-mini';
            const modelList = createElement('select');
            modelList.classList.add('stiae-hidden');
            const loadModels = button('載入模型', 'fa-cloud-arrow-down');
            const modelHint = createElement('div', 'stiae-help');
            modelField.append(model, createElement('div', 'stiae-help', '要用哪一個模型。按「載入模型」可以直接跟服務商要一份清單來挑，也可以自己打。'), loadModels, modelList, modelHint);
            modelList.addEventListener('change', () => {
                if (modelList.value) model.value = modelList.value;
            });
            // ⚠️ A thermometer, not a lock. /models and /chat/completions are two different
            // addresses whose permissions can differ, so this never blocks saving and the
            // model name stays typeable — some relays serve chat and nothing else.
            loadModels.addEventListener('click', async () => {
                const probe = normalizeApiConfig({
                    ...config,
                    endpoint: endpoint.value,
                    apiKey: apiKey.value,
                    viaBackend: viaBackend.checked,
                });
                if (!probe.endpoint) {
                    modelHint.textContent = '請先把上面的網址填好。';
                    return;
                }
                modelHint.textContent = '正在問服務商…';
                modelList.classList.add('stiae-hidden');
                try {
                    const ids = await fetchApiModels(probe);
                    if (!ids.length) {
                        modelHint.textContent = '這個服務商沒有回傳任何模型清單。沒關係，模型名稱直接打上去就行。';
                        return;
                    }
                    modelList.replaceChildren();
                    const placeholder = createElement('option', '', `— 挑一個（共 ${ids.length} 個）—`);
                    placeholder.value = '';
                    modelList.append(placeholder);
                    for (const id of ids) {
                        const option = createElement('option', '', id);
                        option.value = id;
                        modelList.append(option);
                    }
                    if (model.value && ids.includes(model.value)) modelList.value = model.value;
                    modelList.classList.remove('stiae-hidden');
                    modelHint.textContent = `共 ${ids.length} 個模型，挑一個就會自動填進上面。也可以繼續自己打。`;
                } catch (error) {
                    console.error('[ST Inline AI Editor] Model list failed.', error);
                    modelHint.textContent = `${describeRequestError(error, probe.viaBackend)}\n（拿不到清單不代表不能用——模型名稱自己打上去一樣可以存。）`;
                }
            });

            const row = createElement('div', 'stiae-inline-fields');
            const tempField = createElement('div', 'stiae-field');
            tempField.append(createElement('label', '', '溫度'));
            const temperature = createElement('input');
            temperature.name = 'temperature';
            temperature.type = 'number';
            temperature.step = '0.05';
            temperature.min = '0';
            temperature.max = '2';
            temperature.placeholder = '留空＝不送出';
            temperature.value = config.temperature === null ? '' : String(config.temperature);
            tempField.append(temperature, createElement('div', 'stiae-help', 'AI 的自由度：低（0.3）比較穩、照著你說的做；高（1.0）比較有變化。⚠ 不確定就留空——留空代表完全不動這個設定，交給服務商的預設值。有些新型的推理模型只要收到這個數字就會直接拒絕。'));
            const tokensField = createElement('div', 'stiae-field');
            tokensField.append(createElement('label', '', '最大回覆長度'));
            const maxTokens = createElement('input');
            maxTokens.name = 'maxTokens';
            maxTokens.type = 'number';
            maxTokens.min = '64';
            maxTokens.step = '1';
            maxTokens.value = String(config.maxTokens);
            tokensField.append(maxTokens, createElement('div', 'stiae-help', 'AI 這次最多能回多少字（單位是 token，中文一個字大約算 1～2 個）。設太小會讓長回覆被切斷。'));
            row.append(tempField, tokensField);

            const backendLabel = createElement('label', 'stiae-checkbox');
            const viaBackend = createElement('input');
            viaBackend.name = 'viaBackend';
            viaBackend.type = 'checkbox';
            viaBackend.checked = config.viaBackend;
            backendLabel.append(viaBackend, createElement('span', '', BACKEND_SWITCH_LABEL));

            const streamLabel = createElement('label', 'stiae-checkbox');
            const stream = createElement('input');
            stream.name = 'stream';
            stream.type = 'checkbox';
            stream.checked = config.stream;
            streamLabel.append(stream, createElement('span', '', '一邊生成一邊顯示'));

            // Free-form on purpose. What a provider calls its thinking switch differs per
            // provider and moves fast — a built-in 「關閉推理」 checkbox would have to guess
            // which parameter to send, and a stale guess reads as a switch that does
            // nothing. The buttons below only type for you; nothing here is understood at
            // send time.
            const extraField = createElement('div', 'stiae-field');
            extraField.append(createElement('label', '', '額外參數（選填）'));
            const extraBody = createElement('textarea');
            extraBody.name = 'extraBody';
            extraBody.rows = 4;
            extraBody.value = formatExtraBody(config.extraBody);
            extraBody.placeholder = '{\n  "reasoning": { "effort": "none" }\n}';
            const extraHint = createElement('div', 'stiae-help');
            const extraPresets = createElement('div', 'stiae-command-row-actions');
            for (const [label, value] of EXTRA_BODY_PRESETS) {
                const fill = button(label, 'fa-paste');
                fill.addEventListener('click', () => {
                    extraBody.value = JSON.stringify(value, null, 2);
                    extraBody.dispatchEvent(new hostWindow.Event('input', { bubbles: true }));
                });
                extraPresets.append(fill);
            }
            const paintExtra = () => {
                const parsed = parseExtraBody(extraBody.value);
                if (!parsed.ok) {
                    extraHint.textContent = `⚠ ${parsed.error}`;
                    extraHint.classList.add('stiae-warn');
                    return;
                }
                extraHint.classList.remove('stiae-warn');
                extraHint.textContent = parsed.blocked.length
                    ? `⚠ ${parsed.blocked.join('、')} 會被忽略——這幾項有自己的欄位，或動了就會讓工具壞掉。`
                    : '';
                if (parsed.blocked.length) extraHint.classList.add('stiae-warn');
            };
            extraBody.addEventListener('input', paintExtra);
            paintExtra();
            extraField.append(
                extraBody,
                extraHint,
                createElement('div', 'stiae-help', '原樣加進送出的請求裡，工具不會去讀它。**留空就什麼都不加。**'.replace(/\*\*/g, '')),
                createElement('div', 'stiae-help', '最常見的用途是**關掉推理模型的思考**——DeepSeek 之類的模型思考又長又貴，而各家的參數名稱不一樣，所以這裡不做成勾選框。下面兩顆按鈕會幫你填好；其他服務商請查它自己的文件，⚠ 要查的是它「OpenAI 相容端點」接受的參數，不是原生 API 的格式。'.replace(/\*\*/g, '')),
                extraPresets,
                createElement('div', 'stiae-help', '⚠ 有些模型關不掉推理（例如 Claude 的 Fable 5／Mythos 5 是常開的）。另外 OpenRouter 的 exclude 只是不回傳思考內容，模型照樣想、照樣花時間——要真的關掉是 effort: "none"。'),
            );

            form.append(
                nameField,
                endpointField,
                keyField,
                modelField,
                row,
                extraField,
                backendLabel,
                createElement('div', 'stiae-help', '按下指令卻說「連不上」的時候，勾這個。有些服務商不允許網頁直接連它（這是瀏覽器的安全限制，不是你設定錯）；勾了之後改由 SillyTavern 自己的伺服器去送同一個請求，用的還是上面那組網址與金鑰。「載入模型」也會跟著改走這條路。'),
                streamLabel,
                createElement('div', 'stiae-help', '關掉的話，會等 AI 整段寫完才一次跳出來。'),
            );
            hostWindow.setTimeout(() => name.focus(), 0);
        }, form => {
            const name = form.elements.name.value.trim();
            const endpoint = form.elements.endpoint.value.trim();
            if (!name || !endpoint) return undefined;
            // ⚠️ Invalid JSON refuses the save rather than being stored and failing later.
            // A parse error at send time would surface as a failed edit with a message
            // about syntax, hours after the typo and nowhere near the box it came from.
            const extra = parseExtraBody(form.elements.extraBody.value);
            if (!extra.ok) {
                toast('error', `額外參數：${extra.error}`);
                return undefined;
            }
            if (extra.blocked.length) toast('warning', `額外參數裡的 ${extra.blocked.join('、')} 已被忽略。`);
            return normalizeApiConfig({
                ...config,
                name,
                endpoint,
                apiKey: form.elements.apiKey.value.trim(),
                model: form.elements.model.value.trim(),
                temperature: form.elements.temperature.value.trim(),
                maxTokens: form.elements.maxTokens.value,
                viaBackend: form.elements.viaBackend.checked,
                stream: form.elements.stream.checked,
                extraBody: extra.value,
            }, 0);
        });
    }

    function promptCardTitle(card) {
        if (card.kind === 'protocol') return '輸出協定';
        if (card.kind === 'system') return SYSTEM_CARD_SLOTS[card.slot].name;
        return card.name;
    }

    function promptCardMeta(card) {
        if (card.kind === 'protocol') return '鎖定 · 永遠在最前面 · 這段在教 AI 用什麼格式回話，改掉或關掉工具就完全不能用';
        if (card.kind === 'system') {
            const pinned = card.slot === PINNED_LAST ? '鎖定 · 永遠在最後面' : '工具自動填 · 可以調位置';
            return `${pinned} · ${SYSTEM_CARD_SLOTS[card.slot].help}`;
        }
        const marks = [MESSAGE_ROLE_LABELS[card.role]];
        if (card.tag) marks.push(`包在 <${card.tag}> 裡`);
        if (!card.enabled) marks.push('已關閉，這次不送');
        return marks.join(' · ');
    }

    async function showPromptCardForm(existing) {
        const card = existing ? clone(existing) : normalizePromptCard({ kind: 'user', name: '', content: '' });
        return showSimpleForm(existing ? '編輯模組' : '新增模組', form => {
            const nameField = createElement('div', 'stiae-field');
            nameField.append(createElement('label', '', '名稱'));
            const name = createElement('input');
            name.name = 'name';
            name.required = true;
            name.value = existing ? card.name : '';
            name.placeholder = '例如：對白口語化';
            nameField.append(name);

            const row = createElement('div', 'stiae-inline-fields');
            const roleField = createElement('div', 'stiae-field');
            roleField.append(createElement('label', '', '身分'));
            const role = createElement('select');
            role.name = 'role';
            for (const [value, label] of Object.entries(MESSAGE_ROLE_LABELS)) {
                const option = createElement('option', '', label);
                option.value = value;
                role.append(option);
            }
            role.value = card.role;
            roleField.append(role, createElement('div', 'stiae-help', '不確定就選「系統訊息」——那是講給 AI 聽的做事準則，多數自訂內容都屬於這一類。上下相鄰、身分相同的模組會自動併成同一則送出去。'));

            const tagField = createElement('div', 'stiae-field');
            tagField.append(createElement('label', '', '標籤（選填）'));
            const tag = createElement('input');
            tag.name = 'tag';
            tag.value = card.tag;
            tag.placeholder = 'style_guide';
            tagField.append(tag, createElement('div', 'stiae-help', '幫這段內容取個名字包起來，AI 比較容易看出它是獨立的一塊。例如填 style_guide，送出去就會變成「<style_guide> 你的內容 </style_guide>」。不知道要填什麼就留空，不影響使用。（search、replace 這兩個名字不能用，工具內部在用。）'));
            row.append(roleField, tagField);

            const contentField = createElement('div', 'stiae-field');
            contentField.append(createElement('label', '', '內容'));
            const content = createElement('textarea');
            content.name = 'content';
            content.required = true;
            content.value = card.content;
            contentField.append(content);

            form.append(nameField, row, contentField);
            hostWindow.setTimeout(() => name.focus(), 0);
        }, form => {
            const name = form.elements.name.value.trim();
            const content = form.elements.content.value;
            if (!name || !content.trim()) return undefined;
            const wanted = form.elements.tag.value.trim();
            const tag = sanitizePromptTag(wanted);
            if (wanted && !tag) toast('warning', `標籤「${wanted}」不能用，已改成不加標籤。`);
            return normalizePromptCard({ ...card, name, content, role: form.elements.role.value, tag });
        });
    }

    // Draws the card list and hands back a fresh array on every change. Used inline by
    // the 提示詞設定 tab and inside a dialog by the command form, so both views of the
    // same idea are literally the same code.
    //
    // ⚠️ The drop indicator only ever changes colour — it always occupies its space. An
    // indicator that appears on dragstart pushes the list open under the pointer and
    // every landing spot moves, which makes dragging useless while every automated test
    // still passes (synthetic DragEvents never lay anything out).
    function renderPromptCardList(container, cards, onChange) {
        let dragFrom = null;
        const draw = () => {
            container.replaceChildren();
            cards.forEach((card, index) => {
                const pinned = isPinnedCard(card);
                // Three tiers, three looks. Which cards you may touch is the first thing
                // you need off this list, and the wording alone made every row look the
                // same until you actually read it.
                const tier = pinned ? 'stiae-card-locked' : (card.kind === 'system' ? 'stiae-card-system' : 'stiae-card-user');
                const off = card.kind === 'user' && !card.enabled ? ' stiae-card-off' : '';
                const row = createElement('div', `stiae-command-row ${tier}${pinned ? ' stiae-command-row-plain' : ''}${off}`);
                if (!pinned) {
                    const grip = createElement('div', 'stiae-drag-grip');
                    grip.append(createElement('i', 'fa-solid fa-grip-vertical'));
                    row.append(grip);
                    row.draggable = true;
                }
                const icon = createElement('i', `fa-solid ${pinned ? 'fa-lock' : (card.kind === 'system' ? 'fa-gear' : 'fa-note-sticky')}`);
                const label = createElement('div');
                label.append(createElement('strong', '', promptCardTitle(card)), createElement('div', 'stiae-help', promptCardMeta(card)));
                const actions = createElement('div', 'stiae-command-row-actions');
                if (card.kind === 'user') {
                    const toggle = button('', card.enabled ? 'fa-eye' : 'fa-eye-slash', 'stiae-icon-button');
                    toggle.title = card.enabled ? '這次不要送出這張' : '重新啟用';
                    toggle.addEventListener('click', () => {
                        cards[index] = { ...card, enabled: !card.enabled };
                        onChange(cards);
                        draw();
                    });
                    const edit = button('', 'fa-pen', 'stiae-icon-button');
                    edit.title = '編輯';
                    edit.addEventListener('click', async () => {
                        const updated = await showPromptCardForm(card);
                        if (!updated) return;
                        cards[index] = updated;
                        onChange(cards);
                        draw();
                    });
                    const remove = button('', 'fa-trash', 'stiae-icon-button');
                    remove.title = '刪除';
                    remove.addEventListener('click', async () => {
                        if (!await showConfirm(`刪除模組「${card.name}」嗎？`, { confirmLabel: '刪除', danger: true })) return;
                        cards.splice(index, 1);
                        onChange(cards);
                        draw();
                    });
                    actions.append(toggle, edit, remove);
                }
                if (!pinned) {
                    const up = button('', 'fa-arrow-up', 'stiae-icon-button stiae-move-button');
                    up.title = '往上';
                    up.disabled = index <= 1;
                    up.addEventListener('click', () => move(index, index - 1));
                    const down = button('', 'fa-arrow-down', 'stiae-icon-button stiae-move-button');
                    down.title = '往下';
                    down.disabled = index >= cards.length - 2;
                    down.addEventListener('click', () => move(index, index + 1));
                    actions.append(up, down);
                }
                row.append(icon, label, actions);

                if (!pinned) {
                    row.addEventListener('dragstart', event => {
                        dragFrom = index;
                        container.classList.add('stiae-dragging-command');
                        event.dataTransfer.effectAllowed = 'move';
                    });
                    row.addEventListener('dragend', () => {
                        dragFrom = null;
                        container.classList.remove('stiae-dragging-command');
                        draw();
                    });
                }
                // Pinned rows still accept dragover so the row above/below the ends can be
                // reached, but the landing index is clamped inside the free stretch.
                row.addEventListener('dragover', event => {
                    if (dragFrom === null) return;
                    event.preventDefault();
                    const rect = row.getBoundingClientRect();
                    const after = event.clientY > rect.top + rect.height / 2;
                    row.classList.toggle('stiae-drop-after', after);
                    row.classList.toggle('stiae-drop-before', !after);
                });
                row.addEventListener('dragleave', () => {
                    row.classList.remove('stiae-drop-before', 'stiae-drop-after');
                });
                row.addEventListener('drop', event => {
                    event.preventDefault();
                    if (dragFrom === null) return;
                    const rect = row.getBoundingClientRect();
                    move(dragFrom, event.clientY > rect.top + rect.height / 2 ? index + 1 : index);
                });
                container.append(row);
            });
        };
        // ⚠️ Clamped to the stretch between the two pinned cards. 協定 must stay first and
        // 目標內文 last — that pair is what makes "reference material after the prose being
        // edited" impossible to express (ADR-0006).
        const move = (from, to) => {
            const target = Math.min(Math.max(to, 1), cards.length - 1);
            const [moved] = cards.splice(from, 1);
            cards.splice(target > from ? target - 1 : target, 0, moved);
            dragFrom = null;
            container.classList.remove('stiae-dragging-command');
            onChange(cards);
            draw();
        };
        draw();
        return draw;
    }

    async function showCommandForm(existing, isBuiltin = false, groupNames = []) {
        const command = existing ? clone(existing) : normalizeCommand({ name: '', instruction: '', visible: true }, state.settings.commands.length);
        const title = isBuiltin ? '編輯內建指令' : (existing ? '編輯客製指令' : '新增客製指令');
        return showSimpleForm(title, form => {
            if (isBuiltin) {
                form.append(createElement(
                    'div',
                    'stiae-help',
                    '儲存後它就完全照你寫的走，日後更新不會再改動它。要拿回出廠內容按「還原預設」。',
                ));
            }
            const nameField = createElement('div', 'stiae-field');
            nameField.append(createElement('label', '', '名稱'));
            const name = createElement('input');
            name.name = 'name';
            name.required = true;
            name.value = existing ? command.name : '';
            nameField.append(name);

            // Builtins are deliberately left out of grouping: they keep an identity of
            // their own and are never folded into the custom list (ADR-0001).
            //
            // ⚠️ A <select> of existing groups, not a text field. A free-text box makes a
            // typo silently create a second group that looks identical — "對白" and "對白 "
            // are two folders, and nothing tells you which one you just filed this under.
            // Typing is only reachable through the explicit 建立新分組 option.
            const groupField = createElement('div', 'stiae-field');
            const newGroupField = createElement('div', 'stiae-field stiae-hidden');
            if (!isBuiltin) {
                groupField.append(createElement('label', '', '分組'));
                const group = createElement('select');
                group.name = 'group';
                const none = createElement('option', '', '（不分組）');
                none.value = '';
                group.append(none);
                for (const name of groupNames) {
                    const option = createElement('option', '', name);
                    option.value = name;
                    group.append(option);
                }
                const create = createElement('option', '', '＋ 建立新分組…');
                // Marked by a data attribute rather than a magic value: any sentinel string
                // is a group name someone could legitimately type.
                create.dataset.new = '1';
                create.value = '';
                group.append(create);
                group.value = command.group;
                groupField.append(group, createElement('div', 'stiae-help', '同組的指令會收在工具列的同一個資料夾按鈕裡。'));

                newGroupField.append(createElement('label', '', '新分組的名字'));
                const newGroup = createElement('input');
                newGroup.name = 'newGroup';
                newGroup.placeholder = '例如：對白';
                newGroupField.append(newGroup);

                group.addEventListener('change', () => {
                    const creating = group.selectedOptions[0]?.dataset.new === '1';
                    newGroupField.classList.toggle('stiae-hidden', !creating);
                    if (creating) newGroup.focus();
                });
            }

            const row = createElement('div', 'stiae-inline-fields');
            const iconField = createElement('div', 'stiae-field');
            iconField.append(createElement('label', '', '圖示'));
            const icon = createElement('select');
            icon.name = 'icon';
            ICONS.forEach(([value, label]) => {
                const option = createElement('option', '', label);
                option.value = value;
                icon.append(option);
            });
            icon.value = command.icon;
            iconField.append(icon);
            const modeField = createElement('div', 'stiae-field');
            modeField.append(createElement('label', '', '編輯模式'));
            const mode = createElement('select');
            mode.name = 'mode';
            [['patch', '局部修補'], ['replacement', '全文改寫']].forEach(([value, label]) => {
                const option = createElement('option', '', label);
                option.value = value;
                mode.append(option);
            });
            mode.value = command.mode;
            modeField.append(mode);
            row.append(iconField, modeField);

            const instructionField = createElement('div', 'stiae-field');
            instructionField.append(createElement('label', '', '指示'));
            const instruction = createElement('textarea');
            instruction.name = 'instruction';
            instruction.required = true;
            instruction.value = command.instruction;
            instructionField.append(instruction);

            // Held in the closure rather than in a form field: it is a list, not a value.
            // null means 跟隨全域 — the command has no list of its own (ADR-0007).
            const cardsField = createElement('div', 'stiae-field');
            cardsField.append(createElement('label', '', '提示詞模組'));
            const cardsStatus = createElement('div', 'stiae-help');
            const cardsRow = createElement('div', 'stiae-command-row-actions');
            const editCards = button('編輯這條指令的模組', 'fa-layer-group');
            const resetCards = button('改回跟著設定走', 'fa-rotate-left');
            cardsRow.append(editCards, resetCards);
            cardsField.append(cardsStatus, cardsRow);
            const paintCards = () => {
                const own = Array.isArray(command.promptCards);
                cardsStatus.textContent = own
                    ? `專屬的 · 這條指令有自己的 ${command.promptCards.filter(card => card.kind === 'user').length} 個模組，之後改「提示詞設定」不會影響到它`
                    : '跟著設定走 · 用「提示詞設定」那一份。你第一次動它的時候，才會複製一份專屬的給這條指令';
                resetCards.disabled = !own;
            };
            editCards.addEventListener('click', async () => {
                // The copy happens here, at the first edit — not when the command is
                // created. A command nobody has had a reason to change keeps following
                // the global list, so one edit there reaches all of them.
                const working = clone(resolvePromptCards(state.settings, command));
                const changed = await showPromptCardsDialog(`「${name.value.trim() || command.name}」的提示詞模組`, working);
                if (!changed) return;
                command.promptCards = changed;
                paintCards();
            });
            resetCards.addEventListener('click', async () => {
                if (!await showConfirm('改回跟著設定走嗎？這條指令自己那一份模組會被丟掉。', { confirmLabel: '改回去', danger: true })) return;
                command.promptCards = null;
                paintCards();
            });
            paintCards();

            const apiField = createElement('div', 'stiae-field');
            apiField.append(createElement('label', '', '專用的 API 設定（選填）'));
            const apiConfig = createElement('select');
            apiConfig.name = 'apiConfigId';
            addApiConfigOptions(apiConfig, command.apiConfigId, true);
            apiField.append(apiConfig, createElement('div', 'stiae-help', '這條指令要用哪一組 AI 連線。選了就是整組換掉——網址、金鑰、模型、溫度、長度一起換。留空就跟其他指令一樣用預設那組。'));

            const visibleLabel = createElement('label', 'stiae-checkbox');
            const visible = createElement('input');
            visible.name = 'visible';
            visible.type = 'checkbox';
            visible.checked = command.visible;
            visibleLabel.append(visible, createElement('span', '', '顯示在編輯器指令列'));
            form.append(nameField, groupField, newGroupField, row, instructionField, cardsField, apiField, visibleLabel);
            hostWindow.setTimeout(() => name.focus(), 0);
        }, form => {
            const name = form.elements.name.value.trim();
            const instruction = form.elements.instruction.value.trim();
            if (!name || !instruction) return undefined;
            return normalizeCommand({
                ...command,
                name,
                // The field is absent for builtins, which is not the same as it being blank.
                group: readGroupFromForm(form, command.group),
                icon: form.elements.icon.value,
                instruction,
                mode: form.elements.mode.value,
                apiConfigId: form.elements.apiConfigId.value,
                visible: form.elements.visible.checked,
            }, 0);
        });
    }

    // The card list as a dialog, for the command form. Resolves to the edited array, or
    // null if the user backed out — so 跟隨全域 survives an accidental click on 編輯.
    function showPromptCardsDialog(title, cards) {
        return showSimpleForm(title, form => {
            form.append(createElement(
                'div',
                'stiae-help',
                '由上往下就是送給 AI 的順序。🔒 頭尾兩個鎖住不能動：最上面那段在教 AI 用什麼格式回話，最下面那段是要編修的正文——放最後才不會讓 AI 搞混哪一段才是要改的。',
            ));
            const list = createElement('div', 'stiae-command-list');
            const add = button('新增模組', 'fa-plus');
            // The array is mutated in place and read back on submit, so there is nothing
            // for the change callback to do here.
            const redraw = renderPromptCardList(list, cards, () => {});
            add.addEventListener('click', async () => {
                const card = await showPromptCardForm(null);
                if (!card) return;
                // One before the end: the last slot belongs to the pinned 目標內文 card.
                cards.splice(Math.max(cards.length - 1, 1), 0, card);
                redraw();
            });
            form.append(list, add);
        }, () => normalizePromptCards(cards));
    }

    // The clipboard is not reachable from every SillyTavern install, and a settings
    // backup that silently fails to copy is worse than no backup at all. This is the
    // fallback: show the text so it can be selected by hand.
    function showPayloadExport(title, text) {
        return showSimpleForm(title, form => {
            const field = createElement('div', 'stiae-field');
            field.append(createElement('label', '', '代碼'));
            const area = createElement('textarea', 'stiae-payload-text');
            area.value = text;
            area.readOnly = true;
            field.append(area, createElement('div', 'stiae-help', '無法自動存取剪貼簿。請全選這段文字自行複製保存。'));
            form.append(field);
            hostWindow.setTimeout(() => { area.focus(); area.select(); }, 0);
        }, () => null);
    }

    function showSettingsImport() {
        return showSimpleForm('匯入設定代碼', form => {
            const field = createElement('div', 'stiae-field');
            field.append(createElement('label', '', '設定代碼'));
            const area = createElement('textarea', 'stiae-payload-text');
            area.name = 'payload';
            area.required = true;
            area.placeholder = '把「複製設定代碼」產生的文字貼在這裡。';
            field.append(area, createElement('div', 'stiae-help', '會覆蓋目前全部設定。'));
            form.append(field);
            hostWindow.setTimeout(() => area.focus(), 0);
        }, form => {
            const parsed = parseSettingsPayload(form.elements.payload.value);
            // Returning undefined leaves the dialog open so the text can be fixed.
            if (!parsed.ok) {
                toast('error', parsed.error);
                return undefined;
            }
            return parsed;
        });
    }

    function showCommandsImport() {
        return showSimpleForm('匯入指令代碼', form => {
            const field = createElement('div', 'stiae-field');
            field.append(createElement('label', '', '指令代碼'));
            const area = createElement('textarea', 'stiae-payload-text');
            area.name = 'payload';
            area.required = true;
            area.placeholder = '把「複製指令代碼」產生的文字貼在這裡。';
            field.append(area, createElement('div', 'stiae-help', '加進去，不覆蓋。同名的兩條都會留著。'));
            form.append(field);
            hostWindow.setTimeout(() => area.focus(), 0);
        }, form => {
            const parsed = parseCommandsPayload(form.elements.payload.value);
            if (!parsed.ok) {
                toast('error', parsed.error);
                return undefined;
            }
            return parsed;
        });
    }

    // ⚠️ Tabs, not folding sections. Two of the four panes are drag-to-reorder lists, and
    // a fold above one of them changes the height of everything below every time it is
    // opened — landing spots move out from under the pointer mid-drag, which this project
    // has already shipped once and had to undo. Tabs also keep the promise that there is
    // only ever one scrolling area on screen.
    const SETTINGS_TABS = [
        ['api', 'API 設定', 'fa-plug'],
        ['commands', '指令設定', 'fa-wand-magic-sparkles'],
        ['prompt', '提示詞設定', 'fa-layer-group'],
        ['about', '版本與備份', 'fa-clock-rotate-left'],
    ];

    function openSettings(initialTab = 'api') {
        if (state.activeSettings) return;
        const draft = clone(state.settings);
        const overlay = createElement('div', `${ROOT_CLASS} stiae-overlay stiae-sub-layer`);
        const modal = createElement('section', 'stiae-settings-modal');
        const header = createElement('header', 'stiae-header');
        header.append(createElement('strong', '', 'AI 內文編輯器設定'));
        const close = createElement('button', 'stiae-close', '×');
        close.type = 'button';
        header.append(close);
        const tabBar = createElement('nav', 'stiae-tabbar');
        const body = createElement('div', 'stiae-settings-body');
        const panes = {};
        for (const [id] of SETTINGS_TABS) panes[id] = createElement('div', 'stiae-tabpane');

        // ── API 設定 ──────────────────────────────────────────────
        const apiList = createElement('div', 'stiae-command-list');
        const addApiConfig = button('新增一組 API 設定', 'fa-plus');
        const renderApiConfigs = () => {
            apiList.replaceChildren();
            if (!draft.apiConfigs.length) {
                apiList.append(createElement('div', 'stiae-help', '還沒有任何 API 設定。按下面那顆按鈕新增一組，填入網址、金鑰與模型，這個工具才有 AI 可以用。'));
            }
            if (draft.apiConfigs.length && !draft.apiConfigs.some(config => config.id === draft.defaultApiConfigId)) {
                draft.defaultApiConfigId = draft.apiConfigs[0].id;
            }
            draft.apiConfigs.forEach((config, index) => {
                const row = createElement('div', 'stiae-command-row stiae-command-row-plain');
                const pick = createElement('input');
                pick.type = 'radio';
                pick.name = 'stiae-default-api';
                pick.checked = config.id === draft.defaultApiConfigId;
                pick.title = '設為預設';
                pick.addEventListener('change', () => {
                    draft.defaultApiConfigId = config.id;
                    renderApiConfigs();
                });
                const label = createElement('div');
                const title = createElement('strong', '', config.name);
                label.append(title);
                const marks = [config.endpoint || '⚠ 未填網址', config.model || '⚠ 未填模型'];
                // ⚠️ Said out loud. A group with no key looks completely normal until a
                // command is pressed, and an imported backup never carries one.
                if (!config.apiKey) marks.push('⚠ 未填金鑰，這組還不能用');
                if (config.viaBackend) marks.push('由酒館伺服器送出');
                if (Object.keys(config.extraBody).length) marks.push(`額外參數 ${Object.keys(config.extraBody).join('、')}`);
                if (config.id === draft.defaultApiConfigId) marks.push('預設');
                const meta = createElement('div', 'stiae-help', marks.join(' · '));
                if (!config.apiKey || !config.endpoint || !config.model) meta.classList.add('stiae-warn');
                label.append(meta);
                const actions = createElement('div', 'stiae-command-row-actions');
                const edit = button('', 'fa-pen', 'stiae-icon-button');
                edit.title = '編輯';
                edit.addEventListener('click', async () => {
                    const updated = await showApiConfigForm(config);
                    if (!updated) return;
                    draft.apiConfigs[index] = updated;
                    renderApiConfigs();
                });
                const remove = button('', 'fa-trash', 'stiae-icon-button');
                remove.title = '刪除';
                remove.addEventListener('click', async () => {
                    const resolved = resolveCommands(draft);
                    const users = [...resolved.builtins, ...resolved.customs]
                        .filter(command => command.apiConfigId === config.id);
                    const warn = users.length
                        ? `\n\n有 ${users.length} 條指令指定用這一組，刪掉之後它們會改用預設那一組。`
                        : '';
                    if (!await showConfirm(`刪除 API 設定「${config.name}」嗎？${warn}`, { confirmLabel: '刪除', danger: true })) return;
                    draft.apiConfigs.splice(index, 1);
                    renderApiConfigs();
                });
                actions.append(edit, remove);
                row.append(pick, label, actions);
                apiList.append(row);
            });
        };
        addApiConfig.addEventListener('click', async () => {
            const created = await showApiConfigForm(null);
            if (!created) return;
            draft.apiConfigs.push(created);
            if (!draft.defaultApiConfigId) draft.defaultApiConfigId = created.id;
            renderApiConfigs();
        });
        renderApiConfigs();
        panes.api.append(
            createElement('div', 'stiae-field-label', 'API 設定'),
            createElement('div', 'stiae-help', '這個工具用它自己的 AI 連線，跟你主聊天用哪個模型完全無關，也不會去動它。左邊的圓點是「平常預設用哪一組」；每條指令也可以在自己的設定裡指定要用別組。'),
            apiList,
            addApiConfig,
        );

        // ── 提示詞設定 ────────────────────────────────────────────
        const cardList = createElement('div', 'stiae-command-list');
        const addCard = button('新增模組', 'fa-plus');
        const redrawCards = () => renderPromptCardList(cardList, draft.promptCards, cards => { draft.promptCards = cards; });
        addCard.addEventListener('click', async () => {
            const card = await showPromptCardForm(null);
            if (!card) return;
            draft.promptCards.splice(Math.max(draft.promptCards.length - 1, 1), 0, card);
            redrawCards();
        });
        redrawCards();
        panes.prompt.append(
            createElement('div', 'stiae-field-label', '提示詞模組'),
            createElement('div', 'stiae-help', '由上往下就是送給 AI 的順序。你可以新增自己的模組、調整順序，或暫時把某一段關起來。'),
            createElement('div', 'stiae-help', '🔒 頭尾兩個鎖住不能動：最上面那段在教 AI 用什麼格式回話，最下面那段是要編修的正文——放最後才不會讓 AI 搞混哪一段才是要改的。'),
            createElement('div', 'stiae-help', '⚙️ 這幾個的內容是你按下指令的當下工具自動填進去的，改不了，但位置可以調。'),
            cardList,
            addCard,
            createElement('div', 'stiae-help', '這一份是所有指令共用的。除非某條指令自己動過模組（那時它會有一份專屬的），否則改這裡就等於改全部。'),
        );

        const builtinHeader = createElement('div', 'stiae-field-label', '內建指令');
        const builtinList = createElement('div', 'stiae-command-list');

        // Builtins are rendered from resolveCommands rather than from the draft, so the
        // dialog and the toolbar can never disagree about what an override resolves to.
        const renderBuiltins = () => {
            builtinList.replaceChildren();
            for (const command of resolveCommands(draft).builtins) {
                // ⚠️ -plain because a builtin has no drag handle: builtins are not
                // reorderable and not groupable (產品決策 6). The grid is four columns for
                // a custom command's handle, and a three-child row silently fills the
                // wrong ones — the action buttons land in the flexible column and huddle
                // against the name with the right half of the row left empty.
                const row = createElement('div', 'stiae-command-row stiae-command-row-plain');
                const icon = createElement('i', `fa-solid ${command.icon}`);
                const name = createElement('div');
                name.append(createElement('strong', '', command.name));
                const marks = [command.mode === 'patch' ? '局部修補' : '全文改寫'];
                if (!command.visible) marks.push('已隱藏');
                marks.push(command.modified ? '已修改' : '出廠狀態');
                name.append(createElement('div', 'stiae-help', marks.join(' · ')));
                const actions = createElement('div', 'stiae-command-row-actions');
                const toggle = button('', command.visible ? 'fa-eye' : 'fa-eye-slash', 'stiae-icon-button');
                toggle.title = command.visible ? '從指令列隱藏' : '顯示在指令列';
                const edit = button('', 'fa-pen', 'stiae-icon-button');
                edit.title = '編輯';
                const reset = button('', 'fa-rotate-left', 'stiae-icon-button');
                reset.title = command.modified ? '還原預設' : '目前就是出廠內容';
                reset.disabled = !command.modified;
                toggle.addEventListener('click', () => {
                    draft.builtinOverrides[command.id] = { ...command, visible: !command.visible };
                    renderBuiltins();
                });
                edit.addEventListener('click', async () => {
                    const updated = await showCommandForm(command, true);
                    if (updated) {
                        draft.builtinOverrides[command.id] = updated;
                        renderBuiltins();
                    }
                });
                reset.addEventListener('click', async () => {
                    if (await showConfirm(`把內建指令「${command.name}」還原成出廠內容嗎？你對它做的修改會消失。`, { confirmLabel: '還原預設', danger: true })) {
                        delete draft.builtinOverrides[command.id];
                        renderBuiltins();
                    }
                });
                actions.append(toggle, edit, reset);
                row.append(icon, name, actions);
                builtinList.append(row);
            }
        };

        const commandHeader = createElement('div', 'stiae-field-label', '客製指令');
        const commandList = createElement('div', 'stiae-command-list');
        const addCommand = button('新增客製指令', 'fa-plus');

        // Drag and drop moves a command and, when it lands in another group, re-files it.
        // The up/down arrows stay: HTML5 drag-and-drop does not work on touch, and this
        // dialog has to remain fully usable on a phone.
        // Exactly one of these is set while a drag is in flight: a single command by its
        // index, or a whole group by its name.
        let dragFrom = null;
        let dragGroup = null;

        // A line on the edge the thing will land against, rather than lighting up the
        // whole target: with an `after` flag in play, "which side" is the part you need
        // to see before letting go.
        const markDropEdge = (element, after) => {
            element.classList.toggle('stiae-drop-after', after);
            element.classList.toggle('stiae-drop-before', !after);
        };
        const clearDropEdge = element => {
            element.classList.remove('stiae-drop-before', 'stiae-drop-after');
        };

        // ⚠️ Every drop takes an `after` flag, decided by which half of the target the
        // pointer is over. Without it every landing spot means "in front of this", and
        // then nothing can ever reach the last position — a group could not be moved
        // below the loose commands except by dragging those commands one at a time.
        const dropsAfter = (event, element) => {
            const rect = element.getBoundingClientRect();
            return event.clientY > rect.top + rect.height / 2;
        };

        // targetGroup null means "keep whatever group it already has" — that is the
        // heading drop, which is about position only. A string (including '') re-files it.
        const dropCommandAt = (targetIndex, targetGroup, after = false) => {
            if (dragFrom === null) return;
            const wanted = after ? targetIndex + 1 : targetIndex;
            const [moved] = draft.commands.splice(dragFrom, 1);
            // Splicing the source out shifts everything after it down by one.
            const insertAt = wanted > dragFrom ? wanted - 1 : wanted;
            if (targetGroup !== null) moved.group = targetGroup;
            draft.commands.splice(insertAt, 0, moved);
            dragFrom = null;
            renderCommands();
        };

        // Where a group should land relative to `target`. A group is a contiguous block,
        // so "after a member of group X" means after the whole of X — dropping a folder
        // into the middle of another folder is not a thing anyone means.
        const insertIndexFor = (rest, target, after) => {
            const index = rest.indexOf(target);
            if (index < 0) return rest.length;
            const group = target.group || '';
            if (!group) return after ? index + 1 : index;
            if (!after) return rest.findIndex(command => (command.group || '') === group);
            let last = index;
            rest.forEach((command, position) => {
                if ((command.group || '') === group) last = position;
            });
            return last + 1;
        };

        // Moving a group moves every command in it, keeping their order. The toolbar
        // places a folder where its first member sits, so this is also how the folder is
        // moved along the toolbar.
        const dropGroupAt = (targetIndex, after) => {
            if (dragGroup === null) return;
            // targetIndex may be one past the end: that is the gap after the last item.
            const target = draft.commands[targetIndex];
            if (target && (target.group || '') === dragGroup) return;
            const members = draft.commands.filter(command => (command.group || '') === dragGroup);
            const rest = draft.commands.filter(command => (command.group || '') !== dragGroup);
            rest.splice(target ? insertIndexFor(rest, target, after) : rest.length, 0, ...members);
            draft.commands = rest;
            dragGroup = null;
            renderCommands();
        };

        const renderCommands = () => {
            // Re-sorted on every render rather than only on save: a command that just had
            // its group changed has to move to that group now, or the up/down buttons
            // would be acting on positions the list is not showing.
            draft.commands = sortCommandsByGroup(draft.commands);
            commandList.replaceChildren();
            if (!draft.commands.length) commandList.append(createElement('div', 'stiae-help', '尚未建立客製指令。'));
            const grouped = commandGroupNames(draft.commands).length > 0;
            let lastGroup = null;
            // A group's rows live inside a box; a loose command is a bare row on the page.
            // Before this, a group was only a heading with a rule under it, and once the
            // 未分組 heading was dropped there was nothing left to say where a group ended
            // — the list read as one flat run of commands.
            let groupBox = null;
            draft.commands.forEach((command, index) => {
                const group = command.group || '';
                // ⚠️ A heading only for a real group. There is deliberately no 未分組
                // heading: loose commands are not a block, they are individual items that
                // can sit anywhere in the list — including between two folders.
                if (group && group !== lastGroup) {
                    const heading = createElement('div', 'stiae-command-group');
                    const groupGrip = createElement('span', 'stiae-drag-grip');
                    groupGrip.append(createElement('i', 'fa-solid fa-grip-vertical'));
                    groupGrip.title = '拖曳整組換位置';
                    heading.append(groupGrip);
                    heading.draggable = true;
                    heading.addEventListener('dragstart', event => {
                        dragGroup = group;
                        dragFrom = null;
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', group);
                        heading.classList.add('stiae-dragging');
                        commandList.classList.add('stiae-dragging-command');
                    });
                    heading.addEventListener('dragend', () => {
                        dragGroup = null;
                        heading.classList.remove('stiae-dragging');
                        commandList.classList.remove('stiae-dragging-command');
                    });
                    heading.append(createElement('span', '', group));
                    {
                        heading.append(createElement('span', 'stiae-group-spacer'));
                        const rename = button('', 'fa-pen', 'stiae-icon-button stiae-group-action');
                        rename.title = '重新命名這一組';
                        rename.addEventListener('click', async () => {
                            const renamed = await showGroupNameForm(group, commandGroupNames(draft.commands));
                            if (renamed === null || renamed === group) return;
                            // Renaming onto an existing group merges the two. That reads
                            // as what you asked for, so it is allowed rather than blocked.
                            for (const item of draft.commands) {
                                if ((item.group || '') === group) item.group = renamed;
                            }
                            renderCommands();
                        });
                        const dissolve = button('', 'fa-xmark', 'stiae-icon-button stiae-group-action');
                        dissolve.title = '解散這一組';
                        dissolve.addEventListener('click', async () => {
                            const members = draft.commands.filter(item => (item.group || '') === group);
                            const confirmed = await showConfirm(
                                `解散分組「${group}」嗎？\n\n`
                                + `裡面的 ${members.length} 個指令會變成沒有分組。指令本身不會被刪掉。`,
                                { confirmLabel: '解散分組' },
                            );
                            if (!confirmed) return;
                            for (const item of members) item.group = '';
                            renderCommands();
                        });
                        heading.append(rename, dissolve);
                    }
                    // ⚠️ Dropping on a heading puts the thing IN FRONT of that group and
                    // leaves its own grouping alone. Dropping on a command row is what
                    // files something into a group. Two different landing spots for two
                    // different intentions — without the first one there is no way to park
                    // a loose command between two folders, which is exactly what was
                    // missing when 未分組 was welded into one block.
                    heading.addEventListener('dragover', event => {
                        event.preventDefault();
                        event.stopPropagation();
                        markDropEdge(heading, dropsAfter(event, heading));
                    });
                    heading.addEventListener('dragleave', () => clearDropEdge(heading));
                    heading.addEventListener('drop', event => {
                        event.preventDefault();
                        // The box under this heading also accepts drops (as "join this
                        // group"); without stopping here the same drop would run twice
                        // and the second one would undo the first.
                        event.stopPropagation();
                        const after = dropsAfter(event, heading);
                        clearDropEdge(heading);
                        if (dragGroup !== null) dropGroupAt(index, after);
                        else dropCommandAt(index, null, after);
                    });

                    groupBox = createElement('div', 'stiae-group-box');
                    groupBox.append(heading);
                    // Dropping anywhere in the box — including its empty space — files the
                    // command into this group, which is what the box looks like it means.
                    const boxIndex = index;
                    groupBox.addEventListener('dragover', event => {
                        if (dragGroup !== null) return;
                        event.preventDefault();
                        groupBox.classList.add('stiae-drop-target');
                    });
                    groupBox.addEventListener('dragleave', event => {
                        if (!groupBox.contains(event.relatedTarget)) groupBox.classList.remove('stiae-drop-target');
                    });
                    groupBox.addEventListener('drop', event => {
                        event.preventDefault();
                        groupBox.classList.remove('stiae-drop-target');
                        if (dragGroup === null) dropCommandAt(boxIndex, group);
                    });
                    commandList.append(groupBox);
                }
                // A loose command closes whatever box was open: it belongs on the page,
                // not inside the group above it.
                if (!group) groupBox = null;
                lastGroup = group;
                const firstOfGroup = index === 0 || (draft.commands[index - 1].group || '') !== group;
                const lastOfGroup = index === draft.commands.length - 1 || (draft.commands[index + 1].group || '') !== group;
                const row = createElement('div', 'stiae-command-row');
                row.draggable = true;
                row.addEventListener('dragstart', event => {
                    dragFrom = index;
                    event.dataTransfer.effectAllowed = 'move';
                    // Firefox refuses to start a drag without payload.
                    event.dataTransfer.setData('text/plain', command.id);
                    row.classList.add('stiae-dragging');
                    // Reveals the "drop here to leave the group" strip for the duration of
                    // the drag — see looseZone below for why it has to exist at all.
                    commandList.classList.add('stiae-dragging-command');
                });
                row.addEventListener('dragend', () => {
                    dragFrom = null;
                    row.classList.remove('stiae-dragging');
                    commandList.classList.remove('stiae-dragging-command');
                });
                row.addEventListener('dragover', event => {
                    if (dragGroup === null && dragFrom === null) return;
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = 'move';
                    markDropEdge(row, dropsAfter(event, row));
                });
                row.addEventListener('dragleave', () => clearDropEdge(row));
                row.addEventListener('drop', event => {
                    event.preventDefault();
                    // See the heading's drop: the enclosing box would otherwise handle
                    // this a second time.
                    event.stopPropagation();
                    const after = dropsAfter(event, row);
                    clearDropEdge(row);
                    // A whole group lands beside this row; a single command also adopts
                    // this row's group, which is what files it into a folder.
                    if (dragGroup !== null) dropGroupAt(index, after);
                    else dropCommandAt(index, group, after);
                });
                const icon = createElement('i', `fa-solid ${command.icon}`);
                const name = createElement('div');
                name.append(createElement('strong', '', command.name));
                name.append(createElement('div', 'stiae-help', `${command.mode === 'patch' ? '局部修補' : '全文改寫'}${command.visible ? '' : ' · 已隱藏'}`));
                const actions = createElement('div', 'stiae-command-row-actions');
                const toggle = button('', command.visible ? 'fa-eye' : 'fa-eye-slash', 'stiae-icon-button');
                toggle.title = command.visible ? '從指令列隱藏' : '顯示在指令列';
                // ⚠️ Mobile only (.stiae-move-button is hidden on desktop). Dragging
                // replaces these where dragging works — but HTML5 drag-and-drop does not
                // fire on touch, so deleting them outright would leave a phone with no way
                // to reorder anything at all. Movement stays within the group: crossing a
                // boundary here would change the command's group as a side effect.
                const up = button('', 'fa-arrow-up', 'stiae-icon-button stiae-move-button');
                up.title = grouped ? '在這一組裡上移' : '上移';
                up.disabled = firstOfGroup;
                const down = button('', 'fa-arrow-down', 'stiae-icon-button stiae-move-button');
                down.title = grouped ? '在這一組裡下移' : '下移';
                down.disabled = lastOfGroup;
                const edit = button('', 'fa-pen', 'stiae-icon-button');
                edit.title = '編輯';
                const remove = button('', 'fa-trash', 'stiae-icon-button stiae-danger');
                remove.title = '刪除';
                toggle.addEventListener('click', () => { command.visible = !command.visible; renderCommands(); });
                up.addEventListener('click', () => {
                    [draft.commands[index - 1], draft.commands[index]] = [draft.commands[index], draft.commands[index - 1]];
                    renderCommands();
                });
                down.addEventListener('click', () => {
                    [draft.commands[index + 1], draft.commands[index]] = [draft.commands[index], draft.commands[index + 1]];
                    renderCommands();
                });
                edit.addEventListener('click', async () => {
                    const updated = await showCommandForm(command, false, commandGroupNames(draft.commands));
                    if (updated) {
                        draft.commands[index] = updated;
                        renderCommands();
                    }
                });
                remove.addEventListener('click', async () => {
                    if (await showConfirm(`刪除客製指令「${command.name}」嗎？`, { confirmLabel: '刪除', danger: true })) {
                        draft.commands.splice(index, 1);
                        renderCommands();
                    }
                });
                actions.append(toggle, up, down, edit, remove);
                const grip = createElement('span', 'stiae-drag-grip');
                grip.append(createElement('i', 'fa-solid fa-grip-vertical'));
                grip.title = '拖曳排序，或拖到別組';
                row.append(grip, icon, name, actions);
                (groupBox || commandList).append(row);
            });

            // ⚠️ The one way out of a group by dragging: every other landing spot is
            // inside something. Once every command sits in a group there is no bare space
            // left on the page, so without this strip a command could go in and never come
            // out — the settings form's 不分組 being the only escape, which nobody would
            // think to look for.
            //
            // Its height is fixed and it is always in the layout; only its colours change
            // while dragging. An earlier version appeared on dragstart and pushed the list
            // open under the pointer (the dragged row jumped 38px), which made dragging
            // impossible.
            if (draft.commands.length) {
                const looseZone = createElement('div', 'stiae-loose-zone', '移出分組');
                looseZone.addEventListener('dragover', event => {
                    if (dragGroup !== null) return;
                    event.preventDefault();
                    event.stopPropagation();
                    looseZone.classList.add('stiae-drop-target');
                });
                looseZone.addEventListener('dragleave', () => looseZone.classList.remove('stiae-drop-target'));
                looseZone.addEventListener('drop', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    looseZone.classList.remove('stiae-drop-target');
                    if (dragGroup === null) dropCommandAt(draft.commands.length, '');
                });
                commandList.append(looseZone);
            }
        };
        addCommand.addEventListener('click', async () => {
            const created = await showCommandForm(null, false, commandGroupNames(draft.commands));
            if (created) {
                draft.commands.push(created);
                renderCommands();
            }
        });
        // Sits with the command list rather than under 設定備份 on purpose: this pair
        // carries only these commands, and putting it beside the whole-settings backup
        // would make the two look like the same button with a different label.
        const commandBackupRow = createElement('div', 'stiae-inline-fields stiae-button-row');
        const copyCommands = button('複製指令代碼', 'fa-copy');
        const pasteCommands = button('匯入指令代碼', 'fa-paste');
        commandBackupRow.append(copyCommands, pasteCommands);
        const commandBackupHelp = createElement(
            'div',
            'stiae-help',
            '只含客製指令與分組。貼上是加進去，現有的不會被覆蓋。其他設定走下面的「設定備份」。',
        );

        copyCommands.addEventListener('click', async () => {
            if (!draft.commands.length) {
                toast('info', '目前沒有客製指令可以複製。');
                return;
            }
            const text = serializeCommands(draft.commands);
            try {
                await hostWindow.navigator.clipboard.writeText(text);
                toast('success', `指令代碼已複製到剪貼簿（含 ${draft.commands.length} 條客製指令）。`);
            } catch {
                showPayloadExport('複製指令代碼', text);
            }
        });

        pasteCommands.addEventListener('click', async () => {
            const parsed = await showCommandsImport();
            if (!parsed) return;
            // ⚠️ New ids for everything coming in. A backup taken from this same install
            // would otherwise arrive carrying ids that are already in the list.
            const incoming = parsed.commands.map(command => ({ ...command, id: makeId() }));
            const existingNames = new Set(draft.commands.map(command => command.name));
            const duplicates = incoming.filter(command => existingNames.has(command.name)).length;
            draft.commands = sortCommandsByGroup([...draft.commands, ...incoming]);
            renderCommands();
            const dupeNote = duplicates ? `，其中 ${duplicates} 條與現有指令同名（兩邊都留著）` : '';
            toast('success', `已加入 ${incoming.length} 條客製指令${dupeNote}。記得按「儲存設定」。`);
        });

        const backupHeader = createElement('div', 'stiae-field-label', '設定備份');
        const backupRow = createElement('div', 'stiae-inline-fields stiae-button-row');
        const copySettings = button('複製設定代碼', 'fa-copy');
        const pasteSettings = button('匯入設定代碼', 'fa-paste');
        backupRow.append(copySettings, pasteSettings);
        const backupHelp = createElement(
            'div',
            'stiae-help',
            '手動匯入新版時用：舊版按「複製設定代碼」，新版按「匯入設定代碼」。只含設定，不含聊天內容。',
        );

        const updateHeader = createElement('div', 'stiae-field-label', '版本與更新');
        const updateStatus = createElement('div', 'stiae-help');
        const updateRow = createElement('div', 'stiae-inline-fields stiae-button-row');
        const checkUpdate = button('檢查更新', 'fa-rotate');
        const installUpdate = button('更新腳本', 'fa-download', 'stiae-primary');
        updateRow.append(checkUpdate, installUpdate);
        const updateHelp = createElement(
            'div',
            'stiae-help',
            '換掉的是這一支腳本的內容，不是新增一份，所以設定全都留著。換完會自動重新載入，開著的視窗會關閉。',
        );
        const updateNoAuto = createElement(
            'div',
            'stiae-help',
            '只有按下按鈕時才連外網，不會自己去查。',
        );
        const updateRisk = createElement(
            'div',
            'stiae-help',
            '來源固定是本專案的 GitHub，內容會先檢查再寫入。⚠ 但這等於讓那個 repo 在你的瀏覽器裡執行程式碼，不放心就改用手動匯入。',
        );
        const updateLink = createElement('div', 'stiae-help');
        const updateAnchor = createElement('a', '', '在 GitHub 上看變更說明');
        updateAnchor.href = UPDATE_HOME_URL;
        updateAnchor.target = '_blank';
        updateAnchor.rel = 'noreferrer noopener';
        updateLink.append(updateAnchor);
        const updateUnsupported = createElement(
            'div',
            'stiae-reference-bad',
            '你的酒館助手需要 4.8.0 以上才能一鍵更新。目前只能查新版，更新請手動匯入。',
        );
        const changelogBox = createElement('div', 'stiae-changelog');

        // ⚠️ The notes shown are the NEW version's, lifted out of the source that 檢查更新
        // already downloaded — no second request. Reading only the local constant would be
        // backwards: it can only describe the version already installed, which says
        // nothing about whether to update. Before any check has run, and after an update,
        // the local constant is the honest thing to show.
        const renderChangelog = () => {
            changelogBox.replaceChildren();
            const remote = state.update.changelog;
            const entries = remote
                ? changelogSince(remote, VERSION)
                : parseChangelog(CHANGELOG);
            const heading = remote && entries.length ? `更新後你會拿到（${entries.length} 個版本）` : '版本日誌';
            changelogBox.append(createElement('div', 'stiae-field-label', heading));
            if (!entries.length) {
                changelogBox.append(createElement('div', 'stiae-help', remote
                    ? '這一版沒有附上變更說明。'
                    : '讀不到版本日誌。'));
                return;
            }
            for (const entry of entries.slice(0, 10)) {
                changelogBox.append(createElement('div', 'stiae-changelog-version', entry.version));
                const list = createElement('ul', 'stiae-changelog-notes');
                for (const note of entry.notes) list.append(createElement('li', '', note));
                changelogBox.append(list);
            }
        };

        const renderUpdate = () => {
            const supported = scriptUpdateApiAvailable();
            const latest = state.update.latest || draft.updateLatestVersion;
            const newer = Boolean(latest) && compareVersions(latest, VERSION) > 0;
            if (state.update.checking) updateStatus.textContent = `目前版本 ${VERSION} · 正在檢查…`;
            else if (state.update.installing) updateStatus.textContent = `目前版本 ${VERSION} · 正在下載新版…`;
            else if (state.update.error) updateStatus.textContent = `目前版本 ${VERSION} · 上次檢查失敗：${state.update.error}`;
            else if (newer) updateStatus.textContent = `目前版本 ${VERSION} · 有新版本 ${latest}`;
            else if (latest) updateStatus.textContent = `目前版本 ${VERSION} · 已經是最新的`;
            else updateStatus.textContent = `目前版本 ${VERSION} · 還沒檢查過`;
            const busy = state.update.checking || state.update.installing;
            checkUpdate.disabled = busy;
            installUpdate.disabled = busy || !newer;
            installUpdate.querySelector('span').textContent = newer ? `更新到 ${latest}` : '更新腳本';
            installUpdate.classList.toggle('stiae-hidden', !supported);
            updateUnsupported.classList.toggle('stiae-hidden', supported);
            renderChangelog();
        };
        state.updateRender = renderUpdate;
        renderUpdate();
        checkUpdate.addEventListener('click', () => checkForUpdate());
        installUpdate.addEventListener('click', () => runUpdate());

        renderBuiltins();
        renderCommands();
        panes.commands.append(
            builtinHeader,
            builtinList,
            createElement('div', 'stiae-help', '內建指令不能刪除，也不與客製指令混合排序。'),
            commandHeader,
            createElement('div', 'stiae-help', '拖握把排順序，放在目標的上半或下半決定前後。落在指令上會加入它那一組；落在組名上只換位置。拖組名可整組移動；手機請用箭頭。'),
            commandList,
            addCommand,
            commandBackupRow,
            commandBackupHelp,
        );
        // No divider elements between the blocks: .stiae-field-label carries its own
        // rule and spacing, so each heading separates itself from what came before.
        // Having both drew two lines with a gap trapped between them.
        //
        // ⚠️ 正則規則 used to sit here. It moved to the editor's sidebar in 0.8.0 and
        // must not come back: there it is ticked and saved on the spot, and a second
        // copy on this dialog's draft model would commit on 儲存設定 instead — two
        // checkboxes for one setting, free to disagree.
        panes.about.append(
            updateHeader,
            updateStatus,
            updateRow,
            changelogBox,
            updateHelp,
            updateNoAuto,
            updateRisk,
            updateLink,
            updateUnsupported,
            backupHeader,
            backupRow,
            backupHelp,
        );

        for (const [id, label, icon] of SETTINGS_TABS) {
            const tab = button(label, icon, 'stiae-tab');
            tab.dataset.tab = id;
            tab.addEventListener('click', () => showTab(id));
            tabBar.append(tab);
            body.append(panes[id]);
        }
        const showTab = wanted => {
            for (const tab of tabBar.children) tab.classList.toggle('stiae-tab-on', tab.dataset.tab === wanted);
            for (const [id] of SETTINGS_TABS) panes[id].classList.toggle('stiae-hidden', id !== wanted);
            // Each pane is its own scroll position; landing on a tab half-way down is
            // the sort of thing that reads as a rendering bug.
            body.scrollTop = 0;
        };
        showTab(SETTINGS_TABS.some(([id]) => id === initialTab) ? initialTab : 'api');

        const footer = createElement('footer', 'stiae-footer');
        const cancel = button('取消', 'fa-xmark');
        const save = button('儲存設定', 'fa-check', 'stiae-primary');
        footer.append(cancel, save);
        modal.append(header, tabBar, body, footer);
        overlay.append(modal);
        hostDocument.body.append(overlay);
        state.activeSettings = overlay;

        const dismiss = () => {
            overlay.remove();
            state.activeSettings = null;
            state.updateRender = null;
        };
        // Every pane writes straight into `draft` as it is edited, so there are no loose
        // DOM values left to gather here. What this function is still for is the settings
        // this dialog does NOT own.
        const collectDraft = () => {
            // ⚠️ Taken from the live settings, not from the draft. 檢查更新 lives in this
            // same dialog and saves its result immediately; copying the draft's stale
            // value over it would throw away the answer the user just asked for.
            draft.updateLatestVersion = state.settings.updateLatestVersion;
            // Same rule, for the settings this dialog no longer owns. The regex selection
            // and the sidebar's fold state are written the moment they change, out in the
            // editor; the draft is a snapshot from when this dialog opened, and writing it
            // back would quietly undo them.
            draft.regexRuleIds = state.settings.regexRuleIds;
            draft.sidebarSections = state.settings.sidebarSections;
            return normalizeSettings(draft);
        };

        copySettings.addEventListener('click', async () => {
            const text = serializeSettings(collectDraft());
            try {
                await hostWindow.navigator.clipboard.writeText(text);
                toast('success', '設定代碼已複製到剪貼簿。');
            } catch {
                showPayloadExport('複製設定代碼', text);
            }
        });

        pasteSettings.addEventListener('click', async () => {
            const parsed = await showSettingsImport();
            if (!parsed) return;
            const overwrite = await showConfirm(
                '確定要用貼上的設定覆蓋目前全部設定嗎？目前的 API 設定、提示詞模組、內建指令修改與客製指令都會被取代。設定代碼不含 API 金鑰，匯入後要重新填一次。',
                { confirmLabel: '覆蓋設定', danger: true },
            );
            if (!overwrite) return;
            state.settings = parsed.settings;
            saveSettings();
            if (state.activeEditor) {
                renderEditorToolbar(state.activeEditor);
                // ⚠️ An import replaces the two selections the sidebar is showing. Without
                // this the counts would follow the new settings while the boxes below them
                // still showed the old ticks — the sidebar contradicting itself, in plain
                // sight and with nothing to explain it.
                state.activeEditor.worldbookSelection = new Map(state.settings.worldbookSelection
                    .map(ref => [worldbookEntryKey(ref.book, ref.uid), ref]));
                readTavernRegexes().then(rules => {
                    if (state.activeEditor) renderRegexRules(state.activeEditor, rules);
                });
                loadRememberedWorldbooks(state.activeEditor);
                refreshReference(state.activeEditor);
            }
            const from = parsed.sourceVersion ? `（來源版本 ${parsed.sourceVersion}）` : '';
            toast('success', `設定已匯入${from}。`);
            dismiss();
            openSettings();
        });

        close.addEventListener('click', dismiss);
        cancel.addEventListener('click', dismiss);
        save.addEventListener('click', () => {
            state.settings = collectDraft();
            saveSettings();
            if (state.activeEditor) {
                renderEditorToolbar(state.activeEditor);
                // A changed regex selection changes what the open editor would send.
                refreshReference(state.activeEditor);
            }
            toast('success', 'AI 內文編輯器設定已儲存。');
            dismiss();
        });
    }

    // ══════ 生命週期：事件、清理、啟動 ══════

    function onDocumentClick(event) {
        const wand = event.target.closest?.('.stiae-wand');
        if (!wand) return;
        event.preventDefault();
        event.stopPropagation();
        openEditor(Number(wand.dataset.messageId));
    }

    function onDocumentKeydown(event) {
        const wand = event.target.closest?.('.stiae-wand');
        if (wand && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            openEditor(Number(wand.dataset.messageId));
            return;
        }
        // A confirmation handles its own Escape; letting this run too would close the
        // editor out from under the question it is asking. Same for the world info
        // picker and the two preview windows — each is a window in its own right and
        // answers Escape itself. Missing one from this list means Escape closes the
        // editor, and the draft with it, while the user is only reading something.
        if (event.key === 'Escape' && state.activeEditor && !state.activeReview && !state.activeSettings
            && !state.activeConfirm && !state.activeWorldbook && !state.activeTextPreview && !state.activeRequestPreview) {
            requestCloseEditor(state.activeEditor);
        }
    }

    function destroy() {
        if (state.destroyed) return;
        state.destroyed = true;
        state.observer?.disconnect();
        state.activeReview?.close?.();
        state.activeSettings?.remove?.();
        state.activeWorldbook?.remove?.();
        state.activeTextPreview?.remove?.();
        state.activeRequestPreview?.remove?.();
        state.activeEditor?.overlay?.remove?.();
        hostDocument.removeEventListener('click', onDocumentClick, true);
        hostDocument.removeEventListener('keydown', onDocumentKeydown, true);
        hostDocument.querySelectorAll('.stiae-wand').forEach(element => element.remove());
        hostDocument.querySelectorAll(`.${ROOT_CLASS}`).forEach(element => element.remove());
        hostDocument.getElementById(STYLE_ID)?.remove();
        if (hostWindow[INSTANCE_KEY]?.version === VERSION) delete hostWindow[INSTANCE_KEY];
    }

    state.settings = readSettings();
    injectStyles();
    await waitForDocument();
    hostDocument.addEventListener('click', onDocumentClick, true);
    hostDocument.addEventListener('keydown', onDocumentKeydown, true);
    installWandObserver();

    hostWindow[INSTANCE_KEY] = {
        version: VERSION,
        destroy,
        openEditor,
        openSettings,
        core: TEST_API,
    };
    console.info(`[ST Inline AI Editor] v${VERSION} ready.`);
})(typeof window !== 'undefined' ? window : globalThis);
