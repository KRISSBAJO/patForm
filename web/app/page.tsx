import './landing.css';
import { Footer } from '@/components/Footer';
import { Landing } from '@/components/landing';
import { Nav } from '@/components/Nav';

/*
 * The landing page is one story — a single record travelling through the
 * company — and every moving part of it lives in components/landing.tsx.
 * This file only puts the chrome around it.
 */
export default function Home() {
  return (
    <>
      <Nav />
      <Landing />
      <Footer />
    </>
  );
}
