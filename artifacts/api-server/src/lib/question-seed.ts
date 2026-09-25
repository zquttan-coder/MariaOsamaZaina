import type { InsertQuestion } from "@workspace/db";

export const starterQuestions: Array<InsertQuestion & { id: string }> = [
  {
    id: "q-1",
    domain: "Process",
    topic: "Change management",
    approach: "predictive",
    difficulty: "medium",
    question:
      "A key stakeholder asks the project manager to add a new reporting feature. The feature is important, but it was not included in the approved scope. What should the project manager do first?",
    translation:
      "يطلب أحد أصحاب المصلحة إضافة ميزة جديدة للتقارير لم تكن ضمن النطاق المعتمد. ما أول إجراء يجب أن يتخذه مدير المشروع؟",
    options: [
      "Evaluate the request through the integrated change control process.",
      "Add the feature and inform the sponsor after implementation.",
      "Ask the team to estimate the work before documenting the request.",
      "Reject the request because the scope baseline is already approved.",
    ],
    correctAnswer: 0,
    explanation:
      "The request should be documented and evaluated through integrated change control before any commitment is made. This protects the baselines and keeps decision-making transparent.",
  },
  {
    id: "q-2",
    domain: "People",
    topic: "Conflict resolution",
    approach: "agile",
    difficulty: "easy",
    question:
      "Two team members disagree about the acceptance criteria for a user story. The disagreement is delaying the sprint. What should the project manager do?",
    translation:
      "يختلف عضوان في الفريق حول معايير قبول قصة مستخدم، وبدأ الخلاف يؤخر الـSprint. ماذا يفعل مدير المشروع؟",
    options: [
      "Facilitate a conversation so the team can reach a shared understanding.",
      "Select the acceptance criteria that appears most technically complete.",
      "Escalate the conflict to the product sponsor immediately.",
      "Remove the story from the sprint and revisit it next month.",
    ],
    correctAnswer: 0,
    explanation:
      "The project manager should facilitate collaboration and help the team reach a shared understanding. Agile teams solve ambiguity close to the work whenever possible.",
  },
  {
    id: "q-3",
    domain: "Business environment",
    topic: "Benefits realization",
    approach: "hybrid",
    difficulty: "hard",
    question:
      "A project is on schedule and within budget, but a new regulation may reduce the value of its expected benefits. What should the project manager do?",
    translation:
      "المشروع يسير حسب الجدول والميزانية، لكن لائحة جديدة قد تقلل من قيمة المنافع المتوقعة. ماذا يفعل مدير المشروع؟",
    options: [
      "Assess the impact with the sponsor and update the benefits management approach.",
      "Continue as planned because the project constraints are healthy.",
      "Pause all work until the regulation is formally enforced.",
      "Close the project and transfer the remaining budget to another initiative.",
    ],
    correctAnswer: 0,
    explanation:
      "The project manager should reassess the benefit assumptions with the sponsor and update the approach based on evidence. Delivery metrics alone do not guarantee business value.",
  },
  {
    id: "q-4",
    domain: "Process",
    topic: "Risk responses",
    approach: "predictive",
    difficulty: "medium",
    question:
      "During a risk review, the team identifies an opportunity to reduce procurement costs by bundling two purchases. What should happen next?",
    translation:
      "خلال مراجعة المخاطر، اكتشف الفريق فرصة لتقليل تكاليف الشراء عبر دمج عمليتي شراء. ما الخطوة التالية؟",
    options: [
      "Analyze the opportunity and define an appropriate response owner.",
      "Immediately implement the bundle because it is a cost-saving idea.",
      "Ignore it because opportunities are not recorded in the risk register.",
      "Wait until the next phase gate to discuss the opportunity.",
    ],
    correctAnswer: 0,
    explanation:
      "Opportunities are positive risks. They should be analyzed, documented, assigned, and managed with an agreed response rather than acted on informally.",
  },
  {
    id: "q-5",
    domain: "People",
    topic: "Team development",
    approach: "agile",
    difficulty: "easy",
    question:
      "A new team is technically strong but hesitant to raise impediments. Which action best supports a healthy team environment?",
    translation:
      "فريق جديد يتمتع بمهارات تقنية قوية لكنه يتردد في طرح العوائق. ما الإجراء الذي يدعم بيئة صحية للفريق؟",
    options: [
      "Create a safe feedback space and model transparent conversations.",
      "Ask the functional managers to monitor the team more closely.",
      "Publish a weekly list of every impediment and its owner.",
      "Reduce the team’s commitments until they become more confident.",
    ],
    correctAnswer: 0,
    explanation:
      "Psychological safety and transparent communication help teams surface impediments early. The project manager should model the behavior and make feedback easy.",
  },
];