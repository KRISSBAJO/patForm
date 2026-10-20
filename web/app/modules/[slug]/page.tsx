import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Nav } from '@/components/Nav';
import { Footer } from '@/components/Footer';
import { marketingModules, type MarketingModuleKey } from '@/lib/marketing-modules';
import '../../landing.css';
import './modules.css';

type Props = { params: Promise<{ slug: string }> };

function getModule(slug: string) {
  return Object.prototype.hasOwnProperty.call(marketingModules, slug)
    ? marketingModules[slug as MarketingModuleKey]
    : null;
}

export function generateStaticParams() {
  return Object.keys(marketingModules).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const module = getModule(slug);
  if (!module) return {};
  return {
    title: `${module.name} | Patform`,
    description: module.intro,
    openGraph: { title: `${module.name} | Patform`, description: module.intro },
  };
}

export default async function ModulePage({ params }: Props) {
  const { slug } = await params;
  const module = getModule(slug);
  if (!module) notFound();
  const inDevelopment = slug === 'meetings';

  return (
    <>
      <Nav />
      <main className={`module-page module-page--${slug}`} id="top">
        <div className="shell">
          <nav className="module-page__crumb" aria-label="Breadcrumb">
            <Link href="/#modules">All modules</Link><span aria-hidden="true">/</span><span>{module.name}</span>
          </nav>
          <section className="module-page__hero" aria-labelledby="module-title">
            <div className="module-page__heroCopy">
              <span className="module-page__eyebrow">{module.eyebrow} · {module.name}{inDevelopment ? ' · In development' : ''}</span>
              <h1 id="module-title">{module.headline}</h1>
              <p>{module.intro}</p>
              {!inDevelopment && <div className="module-page__actions">
                <Link className="module-page__button module-page__button--primary" href="/signup">Create a workspace <span aria-hidden="true">↗</span></Link>
                <Link className="module-page__textLink" href="/console">Already a member? Open your work <span aria-hidden="true">→</span></Link>
              </div>}
            </div>
            <div className="module-page__art" aria-hidden="true">
              <span className="module-page__artIndex">PATFORM / {String(Object.keys(marketingModules).indexOf(slug) + 1).padStart(2, '0')}</span>
              <Image src={`/images/module-${slug}-v2.webp`} alt="" width={600} height={500} priority className="module-page__image" />
            </div>
          </section>

          <section className="module-page__example" aria-labelledby="module-example">
            <div>
              <span className="module-page__eyebrow">In practice</span>
              <h2 id="module-example">One piece of work, from start to finish.</h2>
            </div>
            <p>{module.example}</p>
          </section>

          <section className="module-page__section" aria-labelledby="module-capabilities">
            <div className="module-page__sectionHead">
              <span className="module-page__eyebrow">What it brings together</span>
              <h2 id="module-capabilities">The details stay connected.</h2>
            </div>
            <div className="module-page__capabilities">
              {module.capabilities.map(([title, body], index) => (
                <article key={title} className="module-page__capability">
                  <span className="module-page__count">0{index + 1}</span>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="module-page__flow" aria-labelledby="module-flow">
            <div className="module-page__sectionHead">
              <span className="module-page__eyebrow">A simple path</span>
              <h2 id="module-flow">How the work moves.</h2>
            </div>
            <ol>
              {module.flow.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span>{step}</li>)}
            </ol>
          </section>

          <section className="module-page__close" aria-labelledby="module-close">
            <div><span className="module-page__eyebrow">{inDevelopment ? 'In development' : 'Get started'}</span><h2 id="module-close">{inDevelopment ? 'More details when the module is ready.' : `Put ${module.name.toLowerCase()} to work.`}</h2></div>
            <Link className="module-page__button module-page__button--light" href={inDevelopment ? '/#modules' : '/signup'}>{inDevelopment ? 'Explore other modules' : 'Create a workspace'} <span aria-hidden="true">↗</span></Link>
          </section>
          <Link href="/#modules" className="module-page__back">← See every module</Link>
        </div>
      </main>
      <Footer />
    </>
  );
}
