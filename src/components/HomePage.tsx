import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { useAuth } from "./Authcontext";
import { naira } from "../lib/Payments";
import Navbar from "./Navbar";
import CountdownTimer from "./CountdownTimer";
import "./HomePage.css";

import pic1 from "../assets/pic11.jpg";
import pic2 from "../assets/pic111.jpg";
import pic3 from "../assets/pic1.jpg";
import pic4 from "../assets/pic1111.jpg";
import pic5 from "../assets/pic11111.jpg";
import bishop from "../assets/bishop.jpg";
import chap from "../assets/chap.jpg";
import achap from "../assets/achap.jpg";
import WinnerBanner from "./Winnerbanner";
import BirthdayBanner from "./Birthdaybanner";
import LiveMatches from "./Livematches";

/**
 * The slides come from Admin → Slideshow (the carousel_slides table): the
 * ones switched to "Showing", in their order there. These five built-in
 * slides are only the fallback, shown when no slide is switched on there
 * (or the slides can't be loaded).
 *
 * Each slide carries its own words, so the write-up changes as the images
 * cycle instead of one fixed caption sitting over five different photos.
 */
const SLIDES = [
  {
    image: pic1,
    eyebrow: "Ibadan North Diocese",
    heading: "Come and grow with us",
    body: "Conventions, retreats, village missions and everything in between. Register once, and you're set for all of it.",
    cta: { label: "See what's on", to: "/programmes" },
  },
  {
    image: pic2,
    eyebrow: "Every archdeaconry",
    heading: "One family, thirteen archdeaconries",
    body: "From Agodi to Yemetu, young people meeting, serving and growing together all year round.",
    cta: { label: "Our programmes", to: "/programmes" },
  },
  {
    image: pic3,
    eyebrow: "Village missions",
    heading: "Take the good news further",
    body: "Volunteer for a village mission and spend a weekend where the need is greatest.",
    cta: { label: "Volunteer", to: "/mission-voluteer" },
  },
  {
    image: pic4,
    eyebrow: "Worship and praise",
    heading: "Lift your voice with us",
    body: "Praise nights, drama, choir and everything that makes our gatherings what they are.",
    cta: { label: "See what's on", to: "/programmes" },
  },
  {
    image: pic5,
    eyebrow: "Support the work",
    heading: "Every gift goes further here",
    body: "Your giving sends young people to conventions they could not otherwise attend.",
    cta: { label: "Give", to: "/donate" },
  },
];

interface HeroSlide {
  key: string;
  image: string;
  eyebrow: string | null;
  heading: string;
  body: string | null;
  cta: { label: string; to: string; external: boolean } | null;
}

const BUILT_IN: HeroSlide[] = SLIDES.map((s, i) => ({
  key: `built-in-${i}`, image: s.image, eyebrow: s.eyebrow, heading: s.heading, body: s.body,
  cta: { label: s.cta.label, to: s.cta.to, external: false },
}));

/**
 * The button on a slide from the admin page. Site pages ("/programmes", or
 * "programmes") stay inside the site; full web addresses, email and phone
 * links open as normal links; anything else (e.g. "javascript:") is dropped.
 */
function slideButton(label: string | null, url: string | null): HeroSlide["cta"] {
  const l = label?.trim();
  let u = url?.trim();
  if (!l || !u) return null;
  if (/^www\./i.test(u)) u = `https://${u}`;
  if (/^(https?:\/\/|mailto:|tel:)/i.test(u)) return { label: l, to: u, external: true };
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("//")) return null;
  return { label: l, to: u.startsWith("/") ? u : `/${u}`, external: false };
}

// Kept between visits to the home page in the same tab, so coming back
// doesn't flash an empty banner while the slides load again.
let slideCache: HeroSlide[] | null = null;

/** Shown only if the leadership table is empty or hasn't loaded yet. */
const FALLBACK_CLERGY = [
  { id: "f1", photo_url: bishop, full_name: "Most Rev'd Williams Aladekugbe",
    role: "Archbishop, Province of Ibadan\nBishop, Ibadan North Diocese" },
  { id: "f2", photo_url: chap, full_name: "Ven. Dr. Ilori L. Tolu-Kehinde",
    role: "Diocesan Youth Chaplain" },
  { id: "f3", photo_url: achap, full_name: "Rev. Canon Adebayo Olayinka",
    role: "Assistant Diocesan Youth Chaplain" },
];

export default function HomePage() {
  const { session, profile } = useAuth();
  const [current, setCurrent] = useState(0);
  const [paused, setPaused] = useState(false);
  const [leadership, setLeadership] = useState<any[]>([]);
  // null while loading: the banner stays plain maroon instead of flashing the wrong slide
  const [adminSlides, setAdminSlides] = useState<HeroSlide[] | null>(slideCache);

  const [popup, setPopup] = useState<any>(null);
  const [programmes, setProgrammes] = useState<any[]>([]);
  const [updates, setUpdates] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);

  /* ---------- carousel ---------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data, error } = await supabase.from("carousel_slides")
        .select("id, image_url, eyebrow, heading, body, cta_label, cta_url")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true });
      const list: HeroSlide[] = error ? [] : (data ?? [])
        .filter((s: any) => s.image_url && s.heading)
        .map((s: any) => ({
          key: s.id, image: s.image_url, eyebrow: s.eyebrow, heading: s.heading, body: s.body,
          cta: slideButton(s.cta_label, s.cta_url),
        }));
      if (!error) slideCache = list;
      if (alive) setAdminSlides(list);
    })();
    return () => { alive = false; };
  }, []);

  const slides: HeroSlide[] = adminSlides === null ? [] : adminSlides.length ? adminSlides : BUILT_IN;
  const count = slides.length;
  const shown = count ? current % count : 0;

  useEffect(() => {
    if (paused || count < 2) return;
    const t = setInterval(() => setCurrent((c) => (c + 1) % count), 6500);
    return () => clearInterval(t);
  }, [paused, count]);

  /* ---------- live content ---------- */
  useEffect(() => {
    (async () => {
      const nowIso = new Date().toISOString();

      const [{ data: announcements }, { data: livePopup }, { data: progs }, { data: prods }] =
        await Promise.all([
        supabase.from("announcements").select("*")
          .eq("is_published", true).order("created_at", { ascending: false }),
        // The view picks the popup for whichever programme happens soonest,
        // falling back to the newest unattached popup.
        supabase.from("home_popup").select("*").maybeSingle(),
        supabase.from("programmes").select("*")
          .eq("is_published", true)
          .or(`starts_at.gte.${nowIso},starts_at.is.null`)
          .order("starts_at", { ascending: true }).limit(3),
        supabase.from("products").select("id, slug, name, price_naira, images")
          .eq("is_active", true).order("created_at", { ascending: false }).limit(4),
      ]);

      const { data: leaders } = await supabase
        .from("leadership").select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      setLeadership(leaders ?? []);

      setProgrammes(progs ?? []);
      setProducts(prods ?? []);
      setUpdates((announcements ?? []).filter((a) => a.kind === "update").slice(0, 3));

      // Show it once per person, per announcement.
      if (livePopup && localStorage.getItem(`popup-seen:${livePopup.id}`) !== "1") {
        setPopup(livePopup);
      }
    })();
  }, []);

  const dismissPopup = () => {
    if (popup) localStorage.setItem(`popup-seen:${popup.id}`, "1");
    setPopup(null);
  };

  const next = programmes[0];
  const clergy = leadership.filter((m) => m.tier === "clergy");
  const excos = leadership.filter((m) => m.tier === "exco");

  return (
    <div className="home">
      {/* ---------- popup, published from /admin/announcements ---------- */}
      {popup && (
        <div className="home-popup" role="dialog" aria-modal="true" aria-label={popup.title}>
          <div className="home-popup-card">
            <button className="home-popup-close" onClick={dismissPopup} aria-label="Close">
              &#10005;
            </button>
            {popup.image_url && <img src={popup.image_url} alt={popup.title} />}
            <div className="home-popup-body">
              <h2>{popup.title}</h2>
              {popup.body && <p>{popup.body}</p>}
              {popup.link_url && (
                <Link className="home-popup-cta" to={popup.link_url} onClick={dismissPopup}>
                  Find out more
                </Link>
              )}
            </div>
          </div>
        </div>
      )}

      <Navbar />
      <WinnerBanner />
      <BirthdayBanner />
      <LiveMatches />

      {/* ---------- carousel ---------- */}
      <section
        className="home-carousel"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        aria-roledescription="carousel"
      >
        {slides.map((slide, i) => (
          <img key={slide.key} src={slide.image} alt=""
               className={`home-slide${i === shown ? " is-active" : ""}`} />
        ))}

        <div className="home-carousel-shade" />

        {/* One caption per slide, cross-fading with the image behind it. */}
        {slides.map((slide, i) => {
          const focus = i === shown ? 0 : -1;
          const eyebrow = session && i === 0 && profile?.full_name
            ? `Welcome back, ${profile.full_name.split(" ")[0]}`
            : slide.eyebrow;
          return (
            <div key={slide.key}
                 className={`home-carousel-overlay${i === shown ? " is-active" : ""}`}
                 aria-hidden={i !== shown}>
              <div className="home-carousel-text">
                {eyebrow && <p className="home-eyebrow">{eyebrow}</p>}
                <h1>{slide.heading}</h1>
                {slide.body && <p className="home-lede">{slide.body}</p>}
                <div className="home-hero-actions">
                  {slide.cta && (slide.cta.external ? (
                    <a href={slide.cta.to} className="home-btn" tabIndex={focus}
                       {...(/^https?:/i.test(slide.cta.to) ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                      {slide.cta.label}
                    </a>
                  ) : (
                    <Link to={slide.cta.to} className="home-btn" tabIndex={focus}>
                      {slide.cta.label}
                    </Link>
                  ))}
                  {session ? (
                    <Link to="/account" className="home-btn home-btn--ghost" tabIndex={focus}>
                      My account
                    </Link>
                  ) : (
                    <Link to="/signup" className="home-btn home-btn--ghost" tabIndex={focus}>
                      Create an account
                    </Link>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {count > 1 && (
          <>
            <button className="home-arrow left" aria-label="Previous slide"
                    onClick={() => setCurrent((shown - 1 + count) % count)}>
              &#10094;
            </button>
            <button className="home-arrow right" aria-label="Next slide"
                    onClick={() => setCurrent((shown + 1) % count)}>
              &#10095;
            </button>

            <div className="home-dots">
              {slides.map((slide, i) => (
                <button key={slide.key} aria-label={slide.heading}
                        aria-current={i === shown}
                        className={i === shown ? "is-active" : ""}
                        onClick={() => setCurrent(i)} />
              ))}
            </div>
          </>
        )}
      </section>

      {/* ---------- countdown to the next thing ---------- */}
      {next?.starts_at && (
        <section className="home-countdown">
          <CountdownTimer
            title={`Counting down to ${next.title}`}
            targetDate={next.starts_at}
          />
        </section>
      )}

      {/* ---------- programmes ---------- */}
      {programmes.length > 0 && (
        <section className="home-section">
          <div className="home-section-head">
            <h2>Coming up</h2>
            <Link to="/programmes">All programmes</Link>
          </div>
          <div className="home-prog-grid">
            {programmes.map((p) => (
              <Link key={p.id} to={`/programmes/${p.slug}`} className="home-prog">
                {p.flyer_url && <img src={p.flyer_url} alt="" loading="lazy" />}
                <div className="home-prog-body">
                  <p className="home-prog-date">
                    {p.starts_at
                      ? new Date(p.starts_at).toLocaleDateString("en-NG",
                          { day: "numeric", month: "short", year: "numeric" })
                      : "Date coming"}
                  </p>
                  <h3>{p.title}</h3>
                  {p.venue && <p className="home-prog-venue">{p.venue}</p>}
                  <span className="home-prog-fee">
                    {p.fee_naira > 0 ? naira(p.fee_naira) : "Free"}
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ---------- store ---------- */}
      {products.length > 0 && (
        <section className="home-section home-section--tint">
          <div className="home-section-head">
            <h2>From the store</h2>
            <Link to="/store">Everything on sale</Link>
          </div>
          <div className="home-shop-grid">
            {products.map((p) => (
              <Link key={p.id} to={`/store/${p.slug}`} className="home-shop">
                <div className="home-shop-image">
                  {p.images?.[0] && <img src={p.images[0]} alt="" loading="lazy" />}
                </div>
                <p className="home-shop-name">{p.name}</p>
                <p className="home-shop-price">{naira(p.price_naira)}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* ---------- updates ---------- */}
      {updates.length > 0 && (
        <section className="home-section">
          <div className="home-section-head"><h2>Latest news</h2></div>
          <div className="home-updates">
            {updates.map((u) => (
              <article key={u.id} className="home-update">
                {u.image_url && <img src={u.image_url} alt="" loading="lazy" />}
                <div>
                  <p className="home-update-date">
                    {new Date(u.created_at).toLocaleDateString("en-NG",
                      { day: "numeric", month: "long", year: "numeric" })}
                  </p>
                  <h3>{u.title}</h3>
                  {u.body && <p className="home-update-body">{u.body}</p>}
                  {u.link_url && <Link to={u.link_url}>Read on</Link>}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* ---------- leadership ---------- */}
      <section className="home-section home-section--tint">
        <div className="home-section-head"><h2>Our leadership</h2></div>

        <div className="home-clergy">
          {(clergy.length > 0 ? clergy : FALLBACK_CLERGY).map((m: any) => (
            <figure key={m.id} className="home-clergy-card">
              {m.photo_url
                ? <img src={m.photo_url} alt={m.full_name} loading="lazy" />
                : <div className="home-avatar-blank">{m.full_name[0]}</div>}
              <figcaption>
                <strong>{m.full_name}</strong>
                <span>{m.role}</span>
              </figcaption>
            </figure>
          ))}
        </div>

        {excos.length > 0 && (
          <>
            <h3 className="home-exco-heading">Diocesan Youth Executives </h3>
            <div className="home-exco-grid">
              {excos.map((m: any) => (
                <figure key={m.id} className="home-exco-card" title={m.bio ?? undefined}>
                  {m.photo_url
                    ? <img src={m.photo_url} alt={m.full_name} loading="lazy" />
                    : <div className="home-avatar-blank">{m.full_name[0]}</div>}
                  <figcaption>
                    <strong>{m.full_name}</strong>
                    <span>{m.role}</span>
                    {m.archdeaconry && <em>{m.archdeaconry}</em>}
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        )}
      </section>

      <footer className="home-footer">
        <p>© {new Date().getFullYear()} Diocesan Youth Organization. All rights reserved.</p>
        <nav>
          <Link to="/programmes">Programmes</Link>
          <Link to="/store">Store</Link>
          <Link to="/donate">Give</Link>
        </nav>
        <p>nkanuzu kwesi Tech</p>
      </footer>
    </div>
  );
}