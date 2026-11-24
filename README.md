# kt-mcp

**🇨🇿 Česky** · [🇬🇧 English](README.en.md)

Self-hosted [MCP](https://modelcontextprotocol.io) server, který propojí AI agenta s vaším jídelníčkem na **kaloricketabulky.cz**.

Řeknete *„snědl jsem 3 vejce a banán"* — agent prohledá českou databázi potravin, vybere správnou porci a zapíše záznamy do vašeho skutečného jídelníčku. Oficiální aplikace zůstává zdrojem pravdy, takže prémiové funkce fungují dál.

Postaveno a otestováno s **Claudem** (desktop, mobil i web přes custom connector), ale server mluví standardním MCP přes HTTPS s OAuth 2.1, takže se může připojit jakýkoli agent, který podporuje vzdálené MCP servery.

> ## Neoficiální projekt, bez vazby na Dine4Fit
>
> kaloricketabulky.cz provozuje společnost **Dine4Fit, a.s.**, která s tímto
> projektem nemá nic společného a nijak ho neschvaluje. Veřejné API neexistuje;
> zde použité endpointy byly vyčteny z frontendového JavaScriptu samotného webu
> a mohou se kdykoli bez varování změnit nebo rozbít.
>
> Podmínky Dine4Fit udělují **osobní, nekomerční** licenci. Tento software je
> zveřejněn proto, abyste si mohli zautomatizovat přístup ke **svému vlastnímu
> účtu** — což licence dovoluje. Provozovat ho jako placenou nebo víceuživatelskou
> službu, případně dál šířit potravinová data, která vrací, je jiná věc a jde
> na váš vrub. Databáze patří Dine4Fit a je chráněna evropskými databázovými právy.
>
> Držte frekvenci požadavků na lidské úrovni. Nestavte na tom konkurenčního klienta.

## Co s tím jde dělat

Jakmile je agent připojený, přestane být zapisování jídel otravným proklikáváním vyhledávání — a jídelníček se dá i číst, rozebírat a opravovat. Pár vzorů, které v praxi fungují dobře:

- **Zapisujte mluvením.** „K snídani jsem měl rohlík se šunkou a dvě vejce." Agent vyhledá potraviny, zvolí přirozené porce (*kus (55 g)* místo odhadovaných gramů) a zapíše každou položku do správného denního jídla.

- **Zapisujte oblíbené.** „Přidej mi můj oblíbený kváskový chléb, dva plátky, ke snídani." Agent ho najde mezi vašimi oblíbenými potravinami (`list_favorite_foods`), zvolí porci a po potvrzení zapíše.

- **Zopakujte včerejšek.** „Zkopíruj včerejší oběd na dnes." nebo „Zkopíruj celý včerejšek na zítra."

- **Zautomatizujte rutinu.** Pijete každý den dvě kávy s mlékem — proč je vypisovat? Pokud váš agent umí naplánované úlohy (Claude umí), řekněte mu to jednou: *„Každý den v 9:00 mi zapiš do jídelníčku dvě espressa s mlékem."* Denní konstanty se zapisují samy.

- **Vyfoťte talíř.** Pošlete agentovi fotku oběda a zeptejte se, co na ní je. Rozpozná potraviny, odhadne reálné gramáže z obrázku, spočítá kalorie — a po potvrzení zaloguje. Odhad je odhad, ale u míchaných talířů je to lepší než nezapsat nic.

- **Vyfoťte recept.** Vyfoťte recept z kuchařky nebo screenshot z webu a řekněte *„ulož mi to jako jídlo"*. Agent přečte suroviny, každou najde v databázi a vytvoří uložený recept — příště zalogujete jedním záznamem. Cestou můžete upravovat: *„vyměň smetanu za bílý jogurt a dej poloviční cukr."*

- **Zjistěte, co vám dává nejvíc.** „Která jídla mi za týden dodala nejvíc bílkovin?" Server sečte nutrient po potravinách přesně (jazykový model by počítal chybně) a neznámé hodnoty nepočítá jako nuly. U uloženého receptu se dá nahlédnout dovnitř: „Z čeho v mé bábovce pochází ty bílkoviny?"

- **Ptejte se, jak vám jde den, týden i měsíc.** „Kolik kalorií a bílkovin mi dnes zbývá?" „Jaký byl můj průměrný deficit za poslední měsíc?" „Jak se mi vyvíjí váha?"

- **Opravujte a doplňujte.** „Ten tvaroh byl 250 g, ne 200." „Smaž dnešní svačinu." „Zapiš půlhodinovou chůzi." „Přidej k obědu poznámku, že to byla restaurace." „Zapiš dnešní váhu 81,7 kg."

- **Řešte, když váha nejde dolů.** „Váha mi stojí, zjisti proč a navrhni úpravu cílů." Agent načte cíle (`get_goals`), odhadne z jídelníčku a vývoje váhy, kolik tělo opravdu spaluje, a porovná to s tím, co předpokládá web (`get_energy_model`). Pak navrhne konkrétní změnu (úroveň aktivity, vlastní bazál, makra) a **zapíše ji až po vašem souhlasu** (`update_goals`). Doporučené je spustit prompt `plateau_review`.

- **Sledujte víc než váhu.** „Zapiš obvod pasu 94 cm." „Jak se mi mění pas a procento tuku?" Když váha stojí, ale pas klesá, ubývá tuk, i když to váha neukazuje. `plateau_review` se na měření podívá sám.

- **Zeptejte se webu na jeho vlastní rozbor.** „Jak plním cíle za posledních 14 dní?" `get_goal_analysis` vrátí průměry proti cílům, největší zdroje bílkovin či tuku a tipy, které web sám odvodil. Stejně jde zjistit, jestli dost pijete (`get_hydration`).

- **Najděte recept podle čísel.** „Najdi večeři do 500 kcal na porci s aspoň 35 g bílkovin do 30 minut." `search_recipes` hledá ve veřejných receptech, `get_recipe` ukáže suroviny, postup a výživu na porci.

- **Opravte, kam jste to zapsali.** „Ten tvaroh patří k snídani, ne k obědu." `move_diary_entry` položku přesune, bez mazání a nového zápisu.

- **Vytáhněte data do tabulky.** „Exportuj posledních 30 dní do CSV." Výsledek vložíte do Excelu nebo Google Sheets.

## Nástroje

Nástroje, které **mění deník**, jsou označené ✏️. Agent by je měl volat až po potvrzení, jakmile je cokoli nejasné; zápisy se nikdy neopakují naslepo.

### Hledání a zápis jídel

| Nástroj | Účel |
|---|---|
| `search_food` | Najde potraviny podle českého názvu nebo 13místného EAN kódu. Vrací id potraviny, které potřebují ostatní nástroje. |
| `get_food_portions` | Vypíše přirozené porce potraviny (`kus (55 g)`, `velký kus (60 g)`), takže „3 vejce" se zapíšou jako tři kusy, ne odhadnutá váha. |
| `get_food_nutrition` | Kalorie a makra pro dané množství, přepočítané samotným webem. Pouze čtení. |
| `log_food` ✏️ | Zapíše záznam o jídle do jídelníčku. |
| `list_favorite_foods` | Oblíbené potraviny, volitelně filtrované podle názvu (bez ohledu na diakritiku a velikost písmen). Id funguje s `get_food_portions` a `log_food`. Pouze čtení. |
| `list_common_foods` | Potraviny, které zapisujete nejčastěji. Pouze čtení. |
| `log_custom_food` ✏️ | Zapíše **vlastní** potravu s názvem a energií, které zadáte (jídlo z restaurace, údaj z obalu), volitelně s gramy živin. Je to jednorázový řádek: do databáze ani mezi oblíbené se nepřidá a později se nevyhledá. Energie je v kcal; pokud váš deník pracuje v kJ, nástroj kcal odmítne a řekne, jakou jednotku použít, takže se kcal nikdy neuloží jako kJ. Má-li potravina v databázi záznam, použijte `search_food` a `log_food`. |
| `add_favorite_food` ✏️ / `remove_favorite_food` ✏️ | Přidá potravinu mezi oblíbené, resp. ji odebere, a ověří výsledek. Neovlivní žádné záznamy. |

### Co jsem snědl (čtení)

| Nástroj | Účel |
|---|---|
| `get_day_summary` | Surové denní součty, cíle a týdenní grafy tak, jak je posílá web. Jednotlivé položky neobsahuje. |
| `get_day_entries` | Jednotlivé zapsané položky jednoho dne (potraviny i uložené recepty), seskupené podle jídla: název, zapsané množství a nutriční hodnoty (včetně vápníku, sodíku a cholesterolu v mg, trans a nenasycených tuků a alkoholu; neznámá hodnota je `null`, ne 0); navíc aktivity a poznámky dne. Každá položka nese `entry_id`, aktivita `activity_id` a poznámka `note_id`. |
| `get_diary_range` | Totéž pro rozsah dnů `from`–`to` (obě krajní data včetně, nejvýš **14** dní). U každého dne uvede, zda je vyplněný, prázdný, nebo se nepodařilo načíst. |
| `get_nutrient_ranking` | Seřadí potraviny podle součtu zvoleného nutrientu (bílkoviny, energie, tuky, sacharidy, vláknina, cukry, nasycené tuky, sůl) za rozsah až **90** dní. |
| `get_day_balance` | Bilance jednoho dne podle webu: příjem proti cíli, výdej (bazál + aktivity), čistá bilance a cíl vs. skutečnost u bílkovin, sacharidů, tuků a dalších živin, vždy s jednotkou. |
| `get_balance_range` | Totéž za rozsah až **90** dní s průměry (jen ze dnů, kdy se něco zapsalo) a počtem načtených a selhaných dnů. |
| `get_weight_history` | Zapsané váhy za měsíc okolo zvoleného dne, aktuální a cílová váha. |
| `export_diary_csv` | Všechny položky za rozsah až **31** dní jako CSV (tečka jako desetinný oddělovač, neznámá hodnota = prázdná buňka). |

### Úpravy deníku

| Nástroj | Účel |
|---|---|
| `update_diary_entry` ✏️ | Změní zapsané množství (a volitelně jednotku) jedné položky. Položky z uloženého receptu web upravit neumí. |
| `move_diary_entry` ✏️ | Přesune položku do jiného jídla téhož dne, na jiný den, nebo obojí (jako přetažení na webu). Množství se nemění. Výsledek se přečte zpět a odpověď říká, kam položka dopadla. |
| `delete_diary_entry` ✏️ | Smaže jednu položku. Předem ověří, že je v daném dni, potom den načte znovu a potvrdí, že je pryč. |
| `copy_meal` ✏️ | Zkopíruje celé jídlo (např. včerejší oběd) na jiný den, volitelně do jiného jídla. **Neidempotentní** — druhé volání vytvoří duplicity. |
| `copy_day` ✏️ | Zkopíruje všechna jídla dne jídlo po jídle do stejných slotů (aktivity a poznámky se nekopírují). Při chybě se zastaví a uvede, co už bylo zkopírováno. Neidempotentní. |
| `search_activity` | Najde aktivitu v katalogu webu (chůze, kolo, …). |
| `log_activity` ✏️ | Zapíše aktivitu na zadaný počet minut; energii spočítá web. Podporuje aktivity měřené v hodinách (chůze, kolo apod.). |
| `delete_activity` ✏️ | Smaže jednu aktivitu dne. Aktivity z hodinek nebo telefonu se mohou při synchronizaci vrátit. |
| `add_diary_note` ✏️ / `delete_diary_note` ✏️ | Přidá poznámku k celému dni nebo k jednomu jídlu, resp. ji smaže. |
| `log_weight` ✏️ | Zapíše hmotnost. Web drží jednu hodnotu na datum, takže přepíše případnou existující. |

### Oblíbené a pravidelné aktivity, šablony dne

| Nástroj | Účel |
|---|---|
| `list_favorite_activities` | Oblíbené aktivity s kcal na kg a minutu a kcal za minutu pro vaši současnou váhu. `activity_id` funguje s `log_activity`. Pouze čtení. |
| `list_common_activities` | Aktivity, které zapisujete nejčastěji. Pouze čtení. Na webu je seznam prázdný, dokud se nenaplní používáním; tvar neprázdného seznamu se při vývoji nedal ověřit. |
| `log_custom_activity` ✏️ | Zapíše **vlastní** aktivitu s názvem, délkou v minutách a spálenou energií (lekce, zápas). Jednorázový řádek, do katalogu se nepřidá. Stejná kontrola jednotky energie jako u vlastní potraviny. Existuje-li aktivita v katalogu, použijte `search_activity` a `log_activity`, kde energii počítá web podle vaší váhy. |
| `add_favorite_activity` ✏️ / `remove_favorite_activity` ✏️ | Přidá aktivitu mezi oblíbené, resp. ji odebere, a ověří výsledek. Zápisy v deníku se nemění. |
| `list_regular_activities` | Týdenní rutina: aktivity, které web opakuje v zadané dny. Každý den má vlastní `regular_activity_id`. Pouze čtení. |
| `add_regular_activity` ✏️ | Přidá aktivitu do týdenní rutiny na vybrané dny (v minutách). Je to **trvalá změna**: web ji od teď počítá v těchto dnech, takže mění energetický obraz každého takového dne. Při nastaveném paušálním výdeji (úroveň aktivity nad sedavou) se může započítat dvakrát. Stejnou aktivitu na stejný den nepřidá podruhé. |
| `delete_regular_activity` ✏️ | Smaže jeden den rutiny. Přijme jen id, které web právě vypsal. Už zapsané aktivity v deníku se nemění. |
| `update_activity` ✏️ | Změní délku zapsané aktivity (v minutách); web přepočítá energii. Jen aktivity měřené v hodinách. Aktivity ze synchronizace (hodinky, telefon) web většinou upravit nedovolí. |
| `list_day_templates` / `get_day_template` | Uložené šablony dne („Moje jídelníčky“) a jejich obsah po jídlech i s poznámkami. Pouze čtení. |
| `save_day_as_template` ✏️ | Uloží potraviny zvoleného dne jako novou šablonu (volitelně i poznámky). Aktivity se do šablony uložit nedají. Druhé volání vytvoří druhou šablonu. |
| `apply_day_template` ✏️ | Zapíše šablonu do 1–7 dnů. Řádky se k dni **přidají**, takže druhé použití nebo použití na den s jídlem je zdvojí. Výsledek porovná počet záznamů každého dne před a po. |
| `delete_day_template` ✏️ | Smaže uloženou šablonu. Dny, do kterých byla dřív zapsána, se nemění. |

### Cíle a odhad výdeje

| Nástroj | Účel |
|---|---|
| `get_goals` | Cíl (zhubnout / udržet / nabrat), váha a cílová váha, úroveň aktivity, bazální metabolismus a kalorický cíl (výpočet webu i vlastní hodnota), cíle živin v gramech i v % a pitný režim. Pole `in_use_today` ukazuje, co deník dnes skutečně používá. Varování upozorní třeba na makra, která nedávají dohromady kalorický cíl. Čte jen vybraná pole; e-mail, heslo, souhlasy a tokeny nevrací. |
| `update_goals` ✏️ | Změní cíl, cílovou váhu, úroveň aktivity (1; 1,2; 1,375; 1,55; 1,725; 1,9), vlastní bazál, vlastní kalorický cíl, cíle živin (g nebo % pro bílkoviny, sacharidy a tuky společně) a pitný režim. Mění jen předaná pole, `null` vlastní hodnotu zruší. Vrací stav před, po, co web nepřevzal a varování. Váhu, e-mail ani heslo nemění. |
| `get_energy_model` (`weeks`, `to`) | Odhad skutečného výdeje: průměrný příjem plus energie uvolněná trendem váhy (1 kg ≈ 7 700 kcal) proti výdeji, který předpokládá web. Vrací rozptyl, spolehlivost (`low` / `medium` / `high`) a výhrady. Dnešek se nezapočítává. |

### Statistiky a měření

| Nástroj | Účel |
|---|---|
| `get_goal_analysis` (`from`, `to`, `meal`, `top_sources`) | Vlastní analýza jídelníčku z webu za období až **366** dní: průměrný denní příjem proti cíli u energie, bílkovin, sacharidů, tuků (i nasycených), vlákniny, soli, vápníku a pitného režimu, největší zdroje každé živiny (potraviny i skupiny potravin) a osobní tipy webu („málo bílkovin 3 dny po sobě“). `meal` zúží analýzu na jedno jídlo. Pouze čtení. |
| `get_hydration` (`from`, `to`) | Litry vypité za den proti dennímu cíli (ten roste s aktivitou), s průměry. Den s 0 l může být jen nezapsaný den, proto jsou průměry zvlášť pro všechny dny a pro dny s nějakým pitím. Pití se zapisuje jako obyčejná potravina (`log_food`). Pouze čtení. |
| `list_tracked_measurements` (`from`, `to`) | Sledované údaje vedle váhy: obvod pasu, boků, břicha, krku, paže, stehna, lýtka, předloktí, hrudníku (horní i dolní), tuky %, svaly %, voda %, viscerální tuky. Hodnoty s `measurement_id`, změna za období a seznam druhů, které jdou začít sledovat. Pouze čtení. |
| `add_tracked_measurement` ✏️ | Zapíše naměřenou hodnotu. Web drží jednu hodnotu na měření a datum, takže další zápis za stejný den **přepíše** předchozí. Dosud nesledované měření web začne sledovat s hodnotou pro **dnešek** (formulář nemá datum), proto se pro něj datum v minulosti odmítne. |
| `delete_tracked_measurement` ✏️ | Smaže jednu hodnotu měření. Přijme jen `measurement_id` z `list_tracked_measurements`, takže se nikdy nedotkne váhy (web maže váhu stejnou cestou). Celé sledování (všechny hodnoty) záměrně smazat nejde. |

### Recepty

| Nástroj | Účel |
|---|---|
| `create_meal` ✏️ | Uloží recept složený z existujících potravin. |
| `list_my_meals` | Vypíše uložené recepty s jejich id a celkovou energií. |
| `get_meal_details` | Suroviny uloženého receptu s množstvím a nutričními hodnotami, součty za celý recept (ne za porci), celková váha a počet porcí (pokud je autor uvedl). |
| `log_meal` ✏️ | Zaloguje uložený recept jako jeden záznam: celý, nebo jeho část podle `portions` (počet porcí), `grams` (snědená hmotnost) či `percent` (podíl). Web surovinám přepočítá množství a výsledek se ověří proti podílu energie receptu. |
| `delete_meal` ✏️ | Smaže uložený recept. |
| `update_meal` ✏️ | Přejmenuje uložený recept, nastaví počet porcí a nahradí postup (kroky). Suroviny se nemění. Výsledek se přečte zpět. |
| `change_meal_ingredients` ✏️ | Přidá, změní nebo odebere suroviny uloženého receptu podle id potraviny; nutriční hodnoty přepočítá web. Potravinu, která je v receptu víckrát, odmítne (nejasné, který řádek), přidání potraviny, která v receptu už je, také (použije se změna množství) a recept musí mít aspoň jednu surovinu. Při změně bez uvedené jednotky řádek jednotku zachová. Už zapsané řádky z receptu se nemění. |

### Veřejné recepty

Recepty ostatních uživatelů z `kaloricketabulky.cz/recepty`. Nejsou to vaše uložené recepty (to je `list_my_meals`).

| Nástroj | Účel |
|---|---|
| `search_recipes` (`query`, `tags`, `sort`, `nutrient`, `min`, `max`, `max_preparation_minutes`, `page`, `limit`) | Hledání podle názvu, štítků (večeře, vegan, bez laktózy…), rozsahu jedné živiny na 100 g a doby přípravy. Řadí podle hodnocení, novosti nebo oblíbenosti. Vrací hodnoty **na 100 g**, počet všech shod a seznam štítků. Pouze čtení. |
| `get_recipe` | Jeden recept: suroviny s množstvím, postup, štítky, doba přípravy, hodnocení a výživa za celý recept, na porci (jen když autor uvedl počet porcí) a na 100 g. Nic nezapisuje; k jídlu ho zapište přes `log_food` nebo uložte přes `create_meal`. Pouze čtení. |

### Prompty

Klienti, které MCP prompty podporují, je nabídnou jako hotové zkratky:

| Prompt | Co udělá |
|---|---|
| `weekly_review` (`from`, `to` volitelné) | Týdenní rozbor (výchozí: posledních 7 dní): průměrný příjem, výdej a bilance, bílkoviny proti cíli, hlavní zdroje bílkovin a trend váhy. |
| `log_favorite` (`food`, `amount`, `meal`, `date`) | Najde oblíbenou potravinu, zvolí porci a před zápisem se zeptá na potvrzení. |
| `plateau_review` (`weeks` volitelné, 2–12, výchozí 4) | „Proč se váha nehýbe?": cíle, odhad výdeje, zapsané dny a trend váhy → nejpravděpodobnější příčina → nejvýš dvě konkrétní změny. **Nic nemění, dokud nepotvrdíte.** |

### Příklady: co řeknete a co agent zavolá

| Řeknete | Agent použije |
|---|---|
| „Přidej mi můj oblíbený kváskový chléb, dva plátky, ke snídani." | `list_favorite_foods` → `get_food_portions` → `log_food` |
| „Která jídla mi za poslední týden dodala nejvíc bílkovin?" | `get_nutrient_ranking` |
| „Z čeho je ta moje mrkvová bábovka a kolik má bílkovin?" | `list_my_meals` → `get_meal_details` |
| „Kolik bílkovin mi dnes ještě chybí?" | `get_day_balance` |
| „Jaký byl můj průměrný deficit za poslední měsíc a jak se mi měnila váha?" | `get_balance_range` + `get_weight_history` |
| „Zkopíruj včerejší oběd na dnes." | `copy_meal` |
| „Ten tvaroh dnes ráno byl 250 g." | `get_day_entries` → `update_diary_entry` |
| „Smaž dnešní odpolední svačinu." | `get_day_entries` → `delete_diary_entry` (po potvrzení) |
| „Zapiš půlhodinovou chůzi." | `search_activity` → `log_activity` |
| „Poznamenej k dnešní večeři, že to byla restaurace." | `add_diary_note` |
| „Zapiš mi váhu 81,7 kg." | `log_weight` |
| „Exportuj posledních 30 dní do CSV." | `export_diary_csv` |
| „Udělej mi týdenní rozbor." | prompt `weekly_review` |
| „Jaké mám nastavené cíle a sedí makra na kalorie?" | `get_goals` |
| „Váha mi stojí, zjisti proč a navrhni úpravu." | prompt `plateau_review` → `get_goals` → `get_energy_model` → (po souhlasu) `update_goals` |
| „Nastav sacharidy na 178 g, ať to vychází na cíl." | `get_goals` → `update_goals` |
| „Změň úroveň aktivity na lehce aktivní." | `get_goals` → `update_goals` |
| „Kolik kalorií má 150 g skyru?" | `search_food` → `get_food_nutrition` |
| „Najdi mi potravinu podle čárového kódu." | `search_food` (13místný EAN) |
| „Zapiš ke snídani 3 vejce a 80 g ovesných vloček." | `search_food` → `get_food_portions` → `log_food` |
| „Co jsem dnes zatím snědl?" | `get_day_entries` |
| „Co jsem jedl minulý týden?" | `get_diary_range` (nejvýš 14 dní najednou) |
| „Jak si stojím dnes proti cílům u bílkovin, sacharidů a tuků?" | `get_day_balance` |
| „Co zapisuju nejčastěji?" | `list_common_foods` |
| „Přidej skyr mezi oblíbené." | `search_food` → `add_favorite_food` |
| „Odeber ho z oblíbených." | `list_favorite_foods` → `remove_favorite_food` |
| „Zkopíruj celý včerejšek na zítra." | `copy_day` |
| „Ulož tenhle recept z fotky jako jídlo." | `search_food` → `create_meal` |
| „Zapiš moji mrkvovou bábovku k večeři." | `list_my_meals` → `log_meal` |
| „K večeři jsem snědl jeden kousek bábovky (z 14 porcí)." | `list_my_meals` → `log_meal` s `portions` = 1 |
| „Z té polévky jsem měl asi čtvrtinu." | `list_my_meals` → `log_meal` s `percent` = 25 |
| „Z gulaše jsem snědl 350 g." | `get_meal_details` → `log_meal` s `grams` = 350 |
| „Smaž ten uložený recept." | `list_my_meals` → `delete_meal` (po potvrzení) |
| „Smaž dnešní chůzi." | `get_day_entries` → `delete_activity` |
| „Smaž poznámku k obědu." | `get_day_entries` → `delete_diary_note` |
| „Jak se mi tenhle měsíc vyvíjela váha a kolik mi zbývá k cíli?" | `get_weight_history` |
| „Odhadni z posledních šesti týdnů, kolik skutečně spaluju." | `get_energy_model` s `weeks` |
| „Nastav makra na 30 % bílkovin, 40 % sacharidů a 30 % tuků." | `get_goals` → `update_goals` (procenta jen pro všechna tři makra společně) |
| „Zruš můj vlastní bazál a vrať výpočet webu." | `get_goals` → `update_goals` (`null` vlastní hodnotu zruší) |
| „Zapiš mou oblíbenou ovesnou kaši k snídani." | prompt `log_favorite` |
| „Ukaž surové denní součty a týdenní grafy tak, jak je posílá web." | `get_day_summary` |
| „Jak plním cíle za posledních 14 dní a co mi web radí?" | `get_goal_analysis` |
| „Z čeho mám nejvíc soli?" | `get_goal_analysis` (zdroje) nebo `get_nutrient_ranking` s `sodium` |
| „Kolik jsem tento týden vypil?" | `get_hydration` |
| „Kolik alkoholu jsem za měsíc vypil a z čeho?" | `get_nutrient_ranking` s `alcohol` |
| „Zapiš obvod pasu 94 cm." | `list_tracked_measurements` → `add_tracked_measurement` |
| „Jak se mi mění pas a procento tuku?" | `list_tracked_measurements` |
| „Smaž tu včerejší hodnotu pasu." | `list_tracked_measurements` → `delete_tracked_measurement` (po potvrzení) |
| „Ten tvaroh patří k snídani, ne k obědu." | `get_day_entries` → `move_diary_entry` |
| „Přesuň večeři z dneška na zítřek." | `get_day_entries` → `move_diary_entry` s `to_date` |
| „Najdi večeři do 500 kcal na 100 g s aspoň 10 g bílkovin." | `search_recipes` |
| „Jak se dělá ten recept a kolik má kcal na porci?" | `get_recipe` |
| „Co obvykle cvičím?" | `list_common_activities` |
| „Dal jsem si v restauraci řízek s bramborami, odhadem 900 kcal, a 40 g bílkovin." | `log_custom_food` |
| „Zapiš hodinu tance, hodinky ukázaly 380 kcal." | `log_custom_activity` |
| „Přejmenuj ten recept na Rychlá polévka a nastav 4 porce." | `list_my_meals` → `update_meal` |
| „V té polévce dej místo mrkve 200 g celeru." | `list_my_meals` → `get_meal_details` → `change_meal_ingredients` |
| „Zapiš moje oblíbené plavání na 45 minut." | `list_favorite_activities` → `log_activity` |
| „Přidej plavání mezi oblíbené aktivity." | `search_activity` → `add_favorite_activity` |
| „Každé pondělí a čtvrtek chodím 40 minut." | `search_activity` → `add_regular_activity` (po potvrzení) |
| „Co mám v týdenní rutině?" | `list_regular_activities` |
| „Zruš pondělní plavání z rutiny." | `list_regular_activities` → `delete_regular_activity` |
| „To plavání včera trvalo 45 minut, ne 30." | `get_day_entries` → `update_activity` |
| „Ulož dnešek jako šablonu Běžný den." | `save_day_as_template` |
| „Zapiš do zítřka šablonu Běžný den." | `list_day_templates` → `get_day_template` → `apply_day_template` |
| „Smaž šablonu Běžný den." | `list_day_templates` → `delete_day_template` (po potvrzení) |

### Jak se zápisy hlídají

- Nástroje, které mění nebo mažou existující záznam (`update_*`, `delete_*`), si vždy nejdřív **načtou den znovu** a ověří, že `entry_id`, `activity_id` nebo `note_id` v něm opravdu je. Smazat nebo upravit se vždy jen **jedna** položka na volání; seznam id oddělených čárkou se nepřijme.
- Po zápisu se den **načte znovu** a výsledek (`confirmed_gone`, `entries_added_to_target_day`, …) se vrátí agentovi. Selže-li jen tohle dodatečné načtení, zápis se **nehlásí jako chyba**, aby ho agent nezopakoval; vrátí se `null` a poznámka, ať si výsledek zkontroluje.
- Všechny nástroje s datem odmítají neexistující dny; web `31.02.2026` tiše přepočítá na 3. 3.
- `update_goals` si profil načte čerstvě, změní jen předaná pole a zbytek formuláře pošle zpět tak, jak přišel (web ukládá celý formulář najednou). Hodnoty mimo rozumný rozsah a nepřípustné kombinace (např. procenta jen u části maker, součet nad 100) odmítne ještě před odesláním. Po zápisu profil přečte znovu a uvede pole, která web nepřevzal.
- `delete_tracked_measurement` přijme jen id hodnoty, kterou web právě vypsal jako sledované měření. Web maže váhy stejnou cestou, takže jiné id se odmítne dřív, než se cokoli smaže. Nové sledování měření se zakládá s hodnotou pro dnešek (formulář nemá datum), proto se pro ně datum v minulosti odmítne.
- `add_regular_activity` a `apply_day_template` jsou schválně označené jako neidempotentní a popis je vysvětluje agentovi. Rutina odmítne duplicitu na stejný den, šablona se zapíše nejvýš do 7 dnů najednou a výsledek hlásí `applied` jen tehdy, když každý den přibyl přesně počet potravin ze šablony. `delete_regular_activity` a `delete_day_template` přijmou jen id, které web právě vypsal.
- `move_diary_entry` si položku nejdřív najde v daném dni, přesun provede po jednom kroku (den, pak jídlo) a výsledek přečte zpět. Pokud položka nedopadla tam, kam měla, `confirmed` není `true`.
- Kopírování a přidávání poznámek a aktivit není idempotentní. Popisy nástrojů to agentovi říkají a výsledek `copy_day` při selhání uvádí, co už se zkopírovalo.

### Limity a cache

| Nástroj | Nejdelší rozsah |
|---|---|
| `get_diary_range` | 14 dní (vrací každou položku) |
| `export_diary_csv` | 31 dní |
| `get_nutrient_ranking`, `get_balance_range` | 90 dní (vrací jen agregáty) |
| `get_goal_analysis`, `get_hydration` | 366 dní (web počítá sám, jedním dotazem) |
| `list_tracked_measurements` | 3 roky |
| `search_recipes` | 25 receptů na stránku |
| `apply_day_template` | 7 dnů na volání |

Dny se načítají postupně, jeden po druhém. Dny, které už skončily, se v serveru **drží v paměti 5 minut**, takže opakovaný dotaz na delší rozsah je rychlý (30 dní: ~3 s → ~0,2 s). Dnešek a budoucnost se nikdy neukládají, každý zápis přes tento server paměť celou vyprázdní a čtení, která zápis ověřují, ji obcházejí. Změna provedená mimo tento server (v aplikaci) se tedy v minulých dnech může objevit až po uplynutí 5 minut.

### Kontrolní skript

Tvar odpovědí webu je odvozený z pozorování, ne z dokumentace, a web ho může změnit. Skript `scripts/smoke.mjs` proti vašemu skutečnému účtu ověří, že klient odpovědím pořád rozumí:

```bash
npm run build
export KT_EMAIL='vas@email' KT_PASSWORD='vase-heslo'
npm run smoke              # pouze čtení
npm run smoke -- --write   # navíc zápisy, viz níže
```

S `--write` se všechny zápisy dějí **jen na zítřek**, který musí být zcela prázdný (jinak se skript zastaví). Zapíše a upraví potravinu, přidá poznámky a aktivitu, zkopíruje jídlo — a všechno zase smaže; zkušební aktivitu dočasně přidá mezi oblíbené a do týdenní rutiny (sobota, neděle) a změní délku zapsané aktivity; uloží zítřek jako šablonu, zapíše ji na pozítří a smaže (všechno zase odstraní); založí zkušební sledování „Obvod krku“ (jen když ho ještě nesledujete), zapíše a smaže hodnotu a nakonec smaže celé zkušební sledování; přesune zkušební položku do jiného jídla a, je-li i pozítří prázdný den, na ten den a zpět; přidá a odebere oblíbenou potravinu, která mezi oblíbenými nebyla, a znovu uloží poslední váhu se stejnou hodnotou. Dočasně také změní pitný režim, vlastní bazál a jeden cíl sacharidů, ověří, že se projevily v cíli deníku, vrátí je a porovná celý blok cílů s původním stavem (včetně kontroly, že uložení profilu nepřidalo záznam váhy). Na konci ověří, že je zítřek zase prázdný. Dnešní ani dřívější dny se nikdy nemění. Návratový kód 1 znamená, že některá kontrola selhala.

### Co zatím není

Web umí víc, než tu dnes nabízíme. Vědomě chybí: úprava řádků, které už byly z receptu zapsány do deníku (web je upravit neumí; smaže se a zapíše znovu), vlastní potravina uložená do databáze a vlastní aktivita uložená do katalogu (zapisují se jen jednorázově), aktivity v šabloně dne a násobení porcí při zápisu šablony (web je při zkoušce nepřevzal), seznam „nejčastějších aktivit“ (čtení je, ale tvar neprázdného seznamu se nedal ověřit), nastavení hodiny, kdy jste jídlo nebo aktivitu absolvovali, smazání celého sledování měření (jen jednotlivých hodnot), vlastní měření mimo 14 druhů webu, e-mail, heslo a ostatní nastavení účtu, přepínač „aktivity zvyšují potřebu živin“ a nativní XLS/PDF export webu (nahrazuje ho `export_diary_csv`). Pití se zapisuje jako obyčejná potravina (např. „voda čistá“ v mililitrech), zvláštní zápis litrů web nemá.

**Sdílení deníku** (Nastavení → Sdílení) web nabízí tak, že další člověk (výživový poradce, rodina) dostane přístup k vašim jídelníčkům, statistikám a poznámkám, případně na omezené období nebo i se zápisem do deníku. Záměrně ho přes agenta nenabízím: je to přístup třetí osoby k zdravotním datům a změnu tohoto druhu má člověk dělat vědomě sám v nastavení webu, ne mimochodem v konverzaci.

### Recepty: množství

Web říká uloženému receptu *jídlo* (meal). `create_meal` ho složí
z existujících potravin, takže „3 vejce a 200 ml mléka" je jedna znovupoužitelná
položka místo dvou záznamů vypisovaných pokaždé znovu.

Množství se řídí stejným pravidlem jako `log_food`: `amount` počítá **jednotky**,
ne gramy. Vynecháte-li `unit_id`, použije se základní jednotka potraviny — gramy
u pevných potravin, mililitry u tekutin — tedy to, v čem se recepty běžně píší.
Když předáte `unit_id` z `get_food_portions`, počet ho násobí: 2 × `porce
(250 ml)` je 500 ml. Splést se je snadné: jeden raný test zadal 100 jednotek
`100 ml` a potichu vytvořil recept s deseti litry mléka.

## Jak to funguje

kaloricketabulky.cz je Spring MVC aplikace, kde každá routa odpoví i v JSON, když přidáte `?format=json` — vrací obálku `{code, data, message}`. Žádné oficiální ani dokumentované API neexistuje; endpointy byly zrekonstruovány z frontendového JavaScriptu webu. Úplná mapa je v `src/kt/client.ts`.

```
Agent  ──OAuth 2.1──►  kt-mcp  ──JSESSIONID──►  kaloricketabulky.cz
       ──MCP/HTTPS─►
```

Dvě hesla, každé hlídá něco jiného:

| Tajemství | Hlídá |
|---|---|
| `MCP_AUTH_PASSWORD` | Kdo smí tento server připojit k agentovi. Zadáváte ho jednou v prohlížeči při OAuth souhlasu. |
| `KT_PASSWORD` | Účet na kaloricketabulky.cz, do kterého nástroje zapisují. Nikdy neopouští server. |

### Co se stane při připojení

Žádný token ručně nevytváříte ani nekopírujete — OAuth to udělá za vás:

1. Do prostředí serveru (`.env`) vložíte svůj **login na kaloricketabulky.cz**
   (`KT_EMAIL` / `KT_PASSWORD`) a **přístupovou frázi, kterou si vymyslíte**
   (`MCP_AUTH_PASSWORD`). Přihlašovací údaje ke kalorickým tabulkám zůstávají
   na vašem serveru; agent je nikdy nevidí.
2. V agentovi přidáte URL konektoru, `https://<your-host>/mcp`. Agent se u
   vašeho serveru zaregistruje sám (dynamická registrace klientů).
3. Otevře se stránka v prohlížeči — obrazovka souhlasu vašeho serveru. Jednou
   zadáte `MCP_AUTH_PASSWORD`.
4. Váš server vygeneruje unikátní náhodný přístupový token a předá ho agentovi,
   který si ho uloží a automaticky obnovuje. Od té chvíle je každé volání
   nástroje ověřené tímto tokenem.

Protože si každý provozuje vlastní instanci, každý token patří jen jemu: váš
server zná jen váš jídelníček a tokeny vydává jen tomu, kdo zná vaši frázi.
Mezi instalacemi se nesdílí nic a žádná centrální služba neexistuje.

## Lokální vývoj

```bash
npm install
cp .env.example .env      # doplňte své údaje
npm run build
npm test

set -a; source .env; set +a
PUBLIC_URL=https://localhost:8092 node dist/index.js
```

`GET /healthz` vrací výsledný veřejný MCP endpoint — nejrychlejší způsob, jak ověřit, že `PUBLIC_URL` je opravdu to, co si myslíte.

## Vlastní hosting

> ⚠️ Server by měl běžet nepřetržitě — na uspávaném PC selžou naplánované
> zápisy. Podrobnosti a doporučení v [HOSTING.md](HOSTING.md).

Referenční nasazení používá Docker, nginx a Cloudflare Tunnel zdarma — na hostiteli ani routeru se neotvírá žádný příchozí port. Funguje ale cokoli jiného, co před kontejner postaví HTTPS hostname; tunel je jen nejlevnější bezpečná výchozí volba.

Cesta požadavku:

```
Cloudflare → cloudflared (host network) → 127.0.0.1:80 → nginx → kt-mcp:8092
```

nginx poslouchá jen na loopbacku hostitele a `cloudflared` se připojuje ven.
Konfigurace nginx (`deploy/nginx.conf.template`) vypíná proxy buffering — bez
toho by Server-Sent Events čekaly na konec streamu a volání nástrojů by se
zasekávala.

**1. Vytvořte tunel** (jednou), v Cloudflare Zero Trust dashboardu → Networks → Tunnels:

- Vytvořte tunel, zkopírujte **tunnel token**.
- Přidejte public hostname se službou **`HTTP`** → **`localhost:80`**.
  `cloudflared` ze stacku běží v host network módu, takže `localhost:80` je
  nginx publikovaný na loopbacku hostitele. Obyčejné `http`, protože TLS
  ukončuje tunel.

Zvolený hostname je dále označován `<your-host>`; funguje jakákoli doména na
vašem Cloudflare účtu a nic v kódu na ni není vázané.

**2. Sestavte image**, z tohoto adresáře:

```bash
docker compose build
```

**3. Nasaďte stack.** `deploy/stack.yml` je runtime compose soubor (funguje samostatně i jako Portainer stack); nastavte tyto proměnné prostředí:

| Proměnná | Hodnota |
|---|---|
| `KT_EMAIL` / `KT_PASSWORD` | Váš login na kaloricketabulky.cz |
| `MCP_HOSTNAME` | `<your-host>` — holý hostname bez schématu. nginx si ho při startu doplní do konfigurace |
| `MCP_AUTH_PASSWORD` | Dlouhá přístupová fráze, kterou si zvolíte (min. 12 znaků) |
| `PUBLIC_URL` | `https://<your-host>` — musí přesně odpovídat hostname tunelu |
| `TUNNEL_TOKEN` | Z kroku 1 |

Udržujte `docker-compose.yml` a `deploy/stack.yml` v souladu — první sestavuje image, druhý ho spouští.

**4. Ověřte nasazení**, než ho připojíte k agentovi:

```bash
./scripts/verify-deployment.sh https://<your-host>
```

**5. Připojte agenta.** V Claudovi: Settings → Connectors → Add custom connector → zadejte `https://<your-host>/mcp`. Agent se sám zaregistruje, otevře stránku souhlasu a vy jednou zadáte `MCP_AUTH_PASSWORD`. Ostatní MCP klienti mají vlastní postup „přidat vzdálený MCP server" se stejnou URL.

### Pozdější změna domény

Hostname není zapečený v image — shodovat se musí jen `PUBLIC_URL` a public
hostname tunelu. Přesun:

1. Přesměrujte public hostname tunelu na novou doménu (nebo vytvořte nový tunel
   a vyměňte `TUNNEL_TOKEN`).
2. Aktualizujte `PUBLIC_URL` na stacku a znovu nasaďte.
3. Znovu spusťte ověřovací skript, pak v agentovi konektor odeberte a přidejte
   znovu.

Krok 3 je nutný: `PUBLIC_URL` je OAuth issuer a identifikátor zdroje podle
RFC 8707, takže tokeny vydané pod starým hostname jsou po přesunu správně
odmítnuty.

### Zaseklí, nebo nemáte kde hostovat?

Pokud při vlastním hostování narazíte, založte [GitHub issue](../../issues) —
rád pomůžu, od toho issue tracker je.

Vlastní hosting potřebuje stroj, který běží nepřetržitě (viz
[HOSTING.md](HOSTING.md)), a účet u Cloudflare. Pokud nemáte kde server
provozovat, ozvěte se na **kt-mcp@stanwhy.me** a něco vymyslíme — jen počítejte
s tím, že provoz privátní instance znamená reálné náklady na server, které by
šly za vámi.

## Autentizace

Server je sám sobě OAuth 2.1 autorizačním serverem a implementuje, co MCP specifikace od chráněného zdroje vyžaduje:

- `/.well-known/oauth-protected-resource/mcp` — RFC 9728 discovery
- `/.well-known/oauth-authorization-server` — RFC 8414 discovery
- `/authorize`, `/token`, `/register`, `/revoke` — authorization code + PKCE, dynamická registrace klientů, rotace refresh tokenů

Přístupové tokeny žijí 30 dní a persistují se do `/data` na volume, takže redeploy nevynutí nové připojení konektoru.

### Co chrání přístupová fráze

`MCP_AUTH_PASSWORD` je jediná cesta k získání tokenu. Každý požadavek na `/mcp`
vyžaduje platný bearer token a tokeny vydává výhradně formulář souhlasu po
porovnání s frází v konstantním čase. Ověřeno auditem
(`scripts/security-audit.sh`): neautentizovaná volání i volání s padělaným
tokenem jsou odmítnuta, vymyšlené autorizační kódy a refresh tokeny jsou
odmítnuty, žádný veřejný endpoint nevydává credential a žádná variace metody či
cesty se k nástrojům bez tokenu nedostane.

Dvě věci jsou veřejné záměrně a bezpečně: OAuth discovery dokumenty (vyžaduje je
specifikace) a dynamická registrace klientů. Registrace klienta útočníkovi nic
nedá — token bez fráze stále nezíská.

Hrubou sílu omezuje limit 100 požadavků za 15 minut na `/authorize`. Limiter
klíčuje podle IP klienta, proto nginx **přepisuje** `X-Forwarded-For` ověřenou
hlavičkou `CF-Connecting-IP` od Cloudflare a aplikace věří přesně jednomu proxy
hopu. Připojování k hlavičce od klienta — nebo `trust proxy: true` — by útočníkovi
dovolilo vyrobit si nový bucket pro každý požadavek a limit by přestal existovat.

Zbytková rizika, o kterých je dobré vědět: kdokoli s frází má plný přístup;
jednotlivé tokeny nelze odvolat jinak než smazáním `/data/oauth-state.json`;
a protože registrace klientů je otevřená, phishingový odkaz na stránku souhlasu
by mohl frázi zachytit, kdybyste ji tam zadali — před autorizací zkontrolujte
jméno klienta zobrazené ve formuláři.

## Omezení

- **Nedokumentovaný upstream.** Dine4Fit tu nic negarantuje; refactoring frontendu může bez varování změnit tvary odpovědí. Klient při čemkoli nečekaném vyhodí chybu místo hádání, takže se rozbití projeví hlasitou chybou, ne špatným počtem kalorií.
- **`md5(hesla)` je ekvivalent hesla.** Web hashuje heslo na klientovi, hash je tedy stejně citlivý jako heslo samotné. Podle toho s `KT_PASSWORD` zacházejte.
- **Jeden účet na instanci.** Server se přihlašuje k jedinému účtu kaloricketabulky.cz. Dva lidé, dva kontejnery.
- **Osobní použití.** Automatizace zápisů do vlastního účtu je mnohem měkčí pozice než hromadný scraping, ale pořád je mimo cokoli, co Dine4Fit posvětil. Držte frekvenci požadavků na lidské úrovni a nestavte na tom konkurenčního klienta.
- **`get_day_summary` jednotlivé položky neobsahuje.** Vrací jen denní součty, cíle, hodnoty z profilu a týdenní grafy, a posílá odpověď webu beze změny dál, protože její tvar není plně zdokumentovaný. Položky čtou `get_day_entries` a `get_diary_range` z endpointu `/user/diary/{dd.MM.yyyy}/get`, který používá i deník na webu.
- **Čtení položek dne vychází z pozorování, ne z dokumentace.** Tvar odpovědi byl odvozen z jednoho účtu za 30 dní a klient při jakékoli odchylce hlásí chybu. Web posílá množství jen jako zobrazený text (`3 x kus (19 g)`); `quantity.raw` je vždy tento text a z něj odvozená čísla jsou `null`, když se text nepodařilo přečíst (některé záznamy množství nemají vůbec). Uložený recept se pozná podle toho, že řádek nese id uloženého jídla, a to je ověřené jen na několika záznamech. Prázdný den neodliší „nejedl jsem nic" od „nezapsal jsem nic". Součty za celý den, které web v téže odpovědi posílá, byly u dnů s položkami nulové, a proto se nepoužívají.
- **Všechny nástroje s datem odmítají neexistující dny.** Web `31.02.2026` tiše přepočítá na 3. 3., takže by se zápis nebo čtení provedlo na jiný den.
- **Zápisy vycházejí z endpointů, které používá web, a byly ověřeny živě na vlastním účtu**, vždy vratně: úprava množství včetně změny jednotky a smazání položky, kopírování jídla, přidání a smazání poznámky (celodenní i k jídlu), přidání a smazání aktivity, přidání a odebrání oblíbené potraviny. `log_weight` byl ověřen jen tím, že se znovu uložila stejná hodnota ke stejnému datu (web drží jedinou hodnotu na datum; zápis nové hodnoty nešlo vrátit zpět, a proto se nezkoušel). Neověřeno: smazání řádku z uloženého receptu, `copy_day` přes víc dnů najednou než v testu a aktivity měřené v jiné jednotce než v hodinách (ty `log_activity` odmítne).
- **Jak web počítá cíle (změřeno na vlastním účtu).** Udržovací příjem = bazál × úroveň aktivity; v režimu „zhubnout" je cíl o pevných 15 % nižší. Změna úrovně aktivity z 1,2 na 1,375 zvedla cíl z 1 783 na 2 043 kcal, vlastní bazál 1 600 ho snížil na 1 632. **Vlastní kalorický cíl model vypne:** web pak neukazuje udržovací příjem ani deficit a jako „výdej" hlásí samotný cíl. Dny, kdy měl účet vlastní cíl, se proto do odhadu `site_expenditure` v `get_energy_model` nepočítají. Hodnota „computed" ve formuláři profilu se po nastavení vlastního bazálu nepřepočítá, a proto `get_goals` vrací i `in_use_today` z denní bilance. Web ukládá energii v kJ, takže vrácená hodnota se může lišit o 1 (1 750 → 1 749).
- **`get_energy_model` je odhad, ne měření.** Potřebuje téměř úplný jídelníček a několik vážení za sebou za srovnatelných podmínek; denní výkyvy vody v řádu kilogramu mohou krátké období přebít. Výsledek vždy nese spolehlivost, rozptyl trendu váhy a seznam výhrad. Dny bez zápisu se přeskakují, takže při neúplném zápisu vyjde skutečný příjem i výdej vyšší.
- **Zápis cílů byl ověřen živě na vlastním účtu**: pitný režim, vlastní bazál a cíl sacharidů se změnily, projevily se v cíli deníku a pak byly vráceny do původního stavu; uložení profilu nepřidalo záznam váhy. Neověřeno: nastavení makra v procentech, změna režimu cíle (zhubnout/udržet/nabrat) a vlastní kalorický cíl se zápisem testoval jen s okamžitým vrácením.
- **Web maže přes obyčejné `GET`.** Proto `delete_*` nástroje před smazáním vždy ověří, že id je v daném dni, a po smazání den načtou znovu.
- **Bilance.** `planned_deficit` je údaj „Kalorický deficit" z webu, tedy cíl minus udržovací příjem, ne to, jak den skutečně dopadl; skutečný rozdíl je `net_balance` (příjem minus výdej, počítá ho server). Příjem 0 znamená, že se nic nezapsalo; web nerozliší „nejedl jsem nic" od „nezapsal jsem nic", a proto průměry v `get_balance_range` počítají jen dny s nenulovým příjmem.
- **Detail receptu** dohledává výživové hodnoty každé suroviny zvlášť (jeden požadavek na surovinu). Surovina, k níž web hodnoty nedá, má `null` a součet se pak týká jen známých.
- **Poznámky dne obsahují celý uživatelský záznam.** Odpověď webu u každé poznámky přibaluje i e-mail a hash hesla. Klient čte jen `id`, `text` a datum a nic dalšího nepředává. Aktivity z různých zdrojů (telefon, hodinky) se mohou překrývat. Pole `drinkRegime` bylo za 30 dní vždy 0, proto se nevystavuje.
- **Část receptu se loguje tak, jak to dělá web.** Server recept sám nepřepočítává: dialog na webu přepočítá v prohlížeči množství každé suroviny a odešle formulář s upravenými množstvími surovin; samotný nejvyšší `count` a jednotku server k výpočtu nepoužívá (proto dřívější pokus s ním zapsal vždy celý recept). `log_meal` dělá totéž, tedy podíl (`portions` / `grams` / `percent`) aplikuje na původní množství každé vybrané suroviny. Odešle se i zvolená jednotka a množství, takže řádek v deníku vypadá přesně jako zapsaný na webu („126 x 1 g“, „0,84 x porce“, „50%“), a výsledek porovná jeho energii s odpovídajícím podílem energie celého receptu (`energy_matches`). Zapsat se dá nejvýš desetinásobek receptu. Po gramech se loguje jen tehdy, když web uvádí váhu každé suroviny a jejich součet sedí (do 2 %) na váhu receptu; jinak se zápis odmítne a použije se `portions` nebo `percent`. `portions` vyžaduje, aby recept měl počet porcí (`get_meal_details`, nastavit jde přes `update_meal`).

## Licence

[MIT](LICENSE). Databáze potravin a služba kaloricketabulky.cz patří Dine4Fit, a.s. — tato licence pokrývá pouze kód v tomto repozitáři.
