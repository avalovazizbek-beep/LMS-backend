-- So'rovnomalar modulini bazadan butunlay olib tashlash (rollback).
-- Faqat modulning o'z jadvallari va 'surveys' ruxsat qatorlari o'chadi —
-- boshqa jadvallar va bildirishnomalar tarixiga tegilmaydi.
--
-- DIQQAT: barcha so'rovnomalar, javoblar va statistika qaytarib bo'lmas
-- darajada o'chadi. Avval zaxira oling:
--   mysqldump lms_portal lms_surveys lms_survey_questions lms_survey_options \
--     lms_survey_targets lms_survey_participations lms_survey_responses \
--     lms_survey_answers lms_survey_notifications lms_dean_faculties > surveys-backup.sql
--
-- Kodni ham eski commit'ga qaytarmasangiz, server keyingi ishga tushganda
-- jadvallarni (bo'sh holda) qayta yaratadi.

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS lms_survey_answers;
DROP TABLE IF EXISTS lms_survey_responses;
DROP TABLE IF EXISTS lms_survey_notifications;
DROP TABLE IF EXISTS lms_survey_participations;
DROP TABLE IF EXISTS lms_survey_targets;
DROP TABLE IF EXISTS lms_survey_options;
DROP TABLE IF EXISTS lms_survey_questions;
DROP TABLE IF EXISTS lms_surveys;
DROP TABLE IF EXISTS lms_dean_faculties;
SET FOREIGN_KEY_CHECKS = 1;

DELETE FROM lms_role_permissions WHERE module = 'surveys';
DELETE FROM lms_notifications WHERE dedupe_key LIKE 'survey:%';
