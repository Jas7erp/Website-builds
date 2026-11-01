# Kapsalon boekingsportaal

Een zelfstandig online afsprakenportaal voor een kapsalon: één boekingspagina voor klanten en een volledige beheeromgeving op `/admin`. Minimalistisch Liquid Glass-design, volledig responsive (mobiel eerst), met lichte en donkere modus.

- **Publiek (`/`)** – behandeling → datum → tijd → gegevens → kortingscode → bevestigen. Aanbetaling via Mollie, bevestigingsmail met agenda-bijlage, en **Mijn afspraak** (wijzigen/annuleren na e-mailverificatie, zonder account).
- **Beheer (`/admin`)** – dashboard, agenda (dag/week/maand), handmatige afspraken, verzetten, annuleren met (gedeeltelijke) terugbetaling, behandelingen, openingstijden/pauzes/vakanties/blokkades/extra beschikbaarheid, kortingscodes met statistieken, betalingsoverzicht, instellingen en Apple Agenda-koppeling.

## Techniek

| Onderdeel | Keuze |
|---|---|
| Backend | Node.js ≥ 20.12, Express 5 |
| Database | SQLite (better-sqlite3, WAL), schema in `src/db.js` |
| Frontend | Vanilla JS + CSS, geen build-stap (`public/`) |
| Betalingen | Mollie Payments API (iDEAL, kaart, Apple Pay, …) incl. refunds |
| E-mail | SMTP via nodemailer |
| Agenda | CalDAV (iCloud) + privé ICS/webcal-abonnement |

```
src/
  app.js              Express-app, beveiligingsheaders, webhook, ICS-feed
  server.js           Opstarten + achtergrondtaken
  db.js               Schema en standaardgegevens
  routes/public.js    Boekings-API en "Mijn afspraak"
  routes/admin.js     Beheer-API (sessie-authenticatie)
  lib/availability.js Beschikbaarheid (openingstijden, pauzes, uitzonderingen, afspraken, buffer)
  lib/pricing.js      Kortingscodes en aanbetalingsberekening
  lib/bookings.js     Boeken, verzetten, annuleren, annuleringsbeleid
  lib/payments.js     Mollie-betalingen, webhooks, terugbetalingen, reconciliatie
  lib/caldav.js       CalDAV-client (discovery, PUT/DELETE)
  lib/calendarSync.js Synchronisatie per boeking + ICS-feed
  lib/mailer.js       E-mailsjablonen en verzending
public/               Boekingspagina en beheeromgeving
test/                 End-to-end tests met testdubbels voor Mollie, CalDAV en SMTP
```

## Installeren en starten

```bash
npm install
```

```bash
cp .env.example .env
```

Vul in `.env` minimaal `PUBLIC_URL` en `APP_SECRET` in. Maak daarna het eigenaarsaccount aan:

```bash
npm run create-admin -- eigenaar@jouwsalon.nl
```

```bash
npm start
```

Open `/admin`, log in en loop de instellingen door: salongegevens en logo, behandelingen, openingstijden, Mollie, e-mail en Apple Agenda. Het dashboard toont waarschuwingen zolang iets nog niet is ingesteld.

Draai in productie achter een https-reverse proxy (bijv. Caddy of nginx) met `TRUST_PROXY=1`, en maak regelmatig een back-up van de map `data/` (database + geheim in ontwikkelmodus).

## Betalingen (Mollie)

1. Maak een Mollie-account en activeer betaalmethoden.
2. Kopieer in het Mollie-dashboard de API-sleutel (`live_…`, of eerst `test_…`).
3. Plak hem in **/admin → Instellingen → Betalingen** en klik *Verbinding testen*.

Werking:
- Per behandeling: geen aanbetaling, vast bedrag of percentage. De aanbetaling wordt berekend over de prijs **na** korting.
- Tijdens het betalen wordt het tijdslot vastgehouden (instelbaar, standaard 20 min). Mislukt de betaling, dan kan de klant opnieuw betalen zolang de reservering geldig is.
- De status wordt altijd zelf bij Mollie opgevraagd (webhook `POST /api/webhooks/mollie`, bij terugkeer van de klant, en elke 2 minuten als vangnet). Webhooks zijn idempotent.
- Komt een betaling binnen nadat de reservering is verlopen én het tijdslot inmiddels bezet is, dan wordt automatisch volledig terugbetaald.
- Annuleren: binnen de termijn volledige terugbetaling; daarna het ingestelde percentage. De eigenaar kan bij annuleren kiezen voor volledig / volgens beleid / geen / ander bedrag, of los terugbetalen. Terugbetalingen lopen echt via de Mollie Refunds API; mislukt die, dan wordt de afspraak niet geannuleerd.
- Zonder geldige Mollie-sleutel kunnen behandelingen met aanbetaling niet online geboekt worden. Er wordt nooit een betaling gesimuleerd.

## E-mail

Stel SMTP in via **Instellingen → E-mail** (of `.env`). Verstuurd worden: bevestiging (met `.ics`-bijlage), wijziging, annulering (met terugbetaling), verificatiecodes voor *Mijn afspraak* en meldingen aan de eigenaar. Elke verzending wordt gelogd en is per afspraak zichtbaar in het beheer.

## Apple Agenda

**Aanbevolen: directe koppeling met iCloud via CalDAV** (Instellingen → Apple Agenda):

1. Maak in de Agenda-app een iCloud-agenda, bijvoorbeeld "Salon".
2. Maak op [account.apple.com](https://account.apple.com) → *Inloggen en beveiliging* → *App-specifieke wachtwoorden* een wachtwoord aan (twee-factor-authenticatie moet aan staan).
3. Vul Apple ID + app-specifiek wachtwoord in, klik *Agenda's zoeken*, kies de agenda en klik *Koppelen*. Er wordt een testitem geplaatst en verwijderd om schrijfrechten te controleren.

Elke bevestigde afspraak wordt een agenda-item met klantnaam, behandeling, datum/tijd, telefoonnummer, e-mail, prijs/aanbetaling en opmerkingen. Het item heeft een vaste URL op basis van de UID van de boeking, dus verzetten werkt het bestaande item bij (geen dubbele items). Bij annuleren wordt het item verwijderd of gemarkeerd als geannuleerd (instelbaar). Mislukte synchronisaties worden automatisch opnieuw geprobeerd en zijn zichtbaar in het beheer.

**Alternatief zonder wachtwoord:** een privé abonnementslink (`webcal://…/agenda/<token>.ics`) die Apple Agenda periodiek ophaalt. Dit is alleen-lezen en heeft wat vertraging. De link kan op elk moment opnieuw worden gegenereerd.

## Beveiliging

- Eigenaarslogin met scrypt-wachtwoordhash, sessiecookie (`HttpOnly`, `SameSite=Strict`, `Secure` bij https), blokkade na 5 mislukte pogingen en rate limiting.
- Origin-controle en JSON-only voor alle API-wijzigingen (CSRF), strikte Content-Security-Policy en beveiligingsheaders.
- Mollie-sleutel, SMTP- en iCloud-wachtwoord versleuteld opgeslagen (AES-256-GCM met `APP_SECRET`).
- *Mijn afspraak*: e-mailadres + boekingscode, daarna 6-cijferige code per e-mail (10 min geldig, max. 5 pogingen, eenmalig); geen informatie-lekken over bestaande boekingen.
- Kortingscodes worden altijd server-side gecontroleerd binnen dezelfde transactie als de boeking (geldigheidsperiode, actief, max. gebruik, één keer per klant op e-mail én telefoon, minimale waarde, behandelingen) met rate limiting tegen raden.
- Dubbele boekingen worden voorkomen doordat beschikbaarheidscontrole en opslag in één exclusieve SQLite-transactie gebeuren.

## Testen

```bash
npm test
```

De end-to-end tests starten de echte applicatie en draaien het volledige proces via de HTTP-API: boeken met en zonder aanbetaling, kortingscodes, dubbele boekingen, webhooks, opnieuw betalen, late betaling met automatische terugbetaling, *Mijn afspraak* met e-mailverificatie, wijzigen, (te laat) annuleren, het beheer en de iCloud-synchronisatie. Mollie, iCloud (CalDAV) en SMTP worden daarbij vervangen door lokale testdubbels in `test/mocks.js`; de applicatiecode zelf bevat geen testmodus.

## Schermafbeeldingen

Zie [`docs/screenshots/`](docs/screenshots/) voor de boekingsflow (desktop en mobiel), "Mijn afspraak" en de beheeromgeving.
